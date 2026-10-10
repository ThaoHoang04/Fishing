import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createWorld, speciesAvailable, BITE_SPEED_RANGE, RARITY_KEYS } from '../src/systems/World.js';
import FishingSessions from '../src/systems/FishingSessions.js';
import { FISHING, RARITIES } from '../src/systems/FishingRules.js';
import { MAPS, getMap } from '../src/data/maps.js';
import { isBlocked, hullRect } from '../src/systems/Collision.js';
import { ReelSim, reelParams, DT } from '../src/systems/ReelSim.js';
import { species, behaviours, byId, bots, play } from './bots.mjs';

const readJson = (rel) => JSON.parse(readFileSync(new URL(rel, import.meta.url), 'utf8'));
const conditions = readJson('../src/data/conditions.json');
const events = readJson('../src/data/events.json');
const spots = readJson('../src/data/spots.json');
const world = createWorld({ conditions, events });
const DAY = conditions.dayMs;
const at = (frac, extra = 0) => Math.floor(frac * DAY) + extra; // a moment at that fraction of the day
const spot = (id) => spots.find((s) => s.id === id);

// Find a moment (for a seed) with the wanted weather; the weather only changes every 90 s slot.
function whenWeather(kind, seed, from = 0) {
  for (let t = from; t < from + conditions.weatherSlotMs * 5000; t += conditions.weatherSlotMs) if (world.weatherAt(t, seed) === kind) return t;
  throw new Error(`no ${kind} found`);
}

// ---------------- clock ----------------

test('the day has four phases that tile the whole cycle exactly', () => {
  const ph = conditions.phases;
  assert.deepEqual(ph.map((p) => p.id), ['dawn', 'day', 'dusk', 'night']);
  assert.equal(ph[0].from, 0);
  assert.equal(ph.at(-1).to, 1);
  for (let i = 1; i < ph.length; i++) assert.equal(ph[i].from, ph[i - 1].to, 'no gaps, no overlaps');
  assert.equal(world.timeOfDay(at(0.0)).phase, 'dawn');
  assert.equal(world.timeOfDay(at(0.3)).phase, 'day');
  assert.equal(world.timeOfDay(at(0.7)).phase, 'dusk');
  assert.equal(world.timeOfDay(at(0.9)).phase, 'night');
  assert.equal(world.timeOfDay(DAY + at(0.3)).phase, 'day', 'it repeats');
  assert.equal(world.timeOfDay(-1).phase, 'night', 'times before the epoch still work');
});

test('daylight rises through dawn, peaks by day, falls through dusk, and never goes fully dark', () => {
  const light = (f) => world.timeOfDay(at(f)).daylight;
  assert.ok(light(0.0) < light(0.06) && light(0.06) < light(0.119), 'dawn brightens');
  assert.equal(light(0.3), 1);
  assert.ok(light(0.63) > light(0.68) && light(0.68) > light(0.73), 'dusk dims');
  assert.equal(light(0.9), 0.12);
  for (let i = 0; i < 1000; i++) {
    const d = world.timeOfDay(Math.floor((i / 1000) * DAY)).daylight;
    assert.ok(d >= 0.12 && d <= 1);
  }
  // no jumps: the brightness never changes by more than a sliver (2%) between moments half a second apart
  let prev = world.timeOfDay(0).daylight;
  for (let t = 500; t < DAY; t += 500) {
    const d = world.timeOfDay(t).daylight;
    assert.ok(Math.abs(d - prev) < 0.02, `jump at ${t}: ${prev} -> ${d}`);
    prev = d;
  }
});

// ---------------- weather ----------------

test('weather is the same for everyone with the same seed and clock, and changes only every slot', () => {
  const seed = 12345;
  for (let slot = 0; slot < 50; slot++) {
    const t = slot * conditions.weatherSlotMs;
    const w = world.weatherAt(t, seed);
    assert.equal(world.weatherAt(t + conditions.weatherSlotMs - 1, seed), w, 'constant within a slot');
    assert.equal(world.weatherAt(t, seed), w, 'deterministic');
    assert.ok(Object.keys(conditions.weatherOdds).includes(w));
  }
  const a = Array.from({ length: 60 }, (_, i) => world.weatherAt(i * conditions.weatherSlotMs, 1));
  const b = Array.from({ length: 60 }, (_, i) => world.weatherAt(i * conditions.weatherSlotMs, 2));
  assert.notDeepEqual(a, b, 'another seed gives another sky');
});

test('weather follows the configured odds over a long time (clear most often, storms rare)', () => {
  const counts = { clear: 0, rain: 0, fog: 0, storm: 0 };
  const N = 40000;
  for (let i = 0; i < N; i++) counts[world.weatherAt(i * conditions.weatherSlotMs, 777)]++;
  const total = Object.values(conditions.weatherOdds).reduce((a, b) => a + b, 0);
  for (const [kind, odds] of Object.entries(conditions.weatherOdds)) {
    assert.ok(Math.abs(counts[kind] / N - odds / total) < 0.012, `${kind}: ${counts[kind] / N} vs ${odds / total}`);
  }
  assert.ok(counts.clear > counts.rain && counts.rain > counts.fog && counts.fog > counts.storm);
});

// ---------------- config ----------------

test('conditions and events are valid, config-driven data', () => {
  const phaseIds = conditions.phases.map((p) => p.id);
  const kinds = Object.keys(conditions.weatherOdds);
  assert.deepEqual(Object.keys(conditions.time).sort(), [...phaseIds].sort(), 'a modifier entry for every phase');
  assert.deepEqual(Object.keys(conditions.weather).sort(), [...kinds].sort(), 'and for every weather');
  const checkEffects = (fx, label) => {
    if (fx.biteSpeed !== undefined) assert.ok(fx.biteSpeed >= BITE_SPEED_RANGE[0] && fx.biteSpeed <= BITE_SPEED_RANGE[1], `${label} biteSpeed`);
    for (const [r, m] of Object.entries(fx.rarityModifier ?? {})) {
      assert.ok(RARITY_KEYS.includes(r), `${label}: unknown rarity ${r}`);
      assert.ok(m > 0 && m <= 5, `${label}: ${r} x${m}`);
    }
  };
  for (const [k, v] of Object.entries({ ...conditions.time, ...conditions.weather })) checkEffects(v, k);

  const ids = new Set();
  for (const e of events) {
    assert.match(e.id, /^[a-z_]+$/);
    assert.ok(!ids.has(e.id), `duplicate event ${e.id}`);
    ids.add(e.id);
    assert.ok(e.name && e.text, `${e.id} needs a name and a description`);
    assert.ok(e.maps.length > 0 && e.maps.every((m) => getMap(m)), `${e.id} lists a map that does not exist`);
    for (const t of e.when.time ?? []) assert.ok(phaseIds.includes(t), `${e.id}: unknown time ${t}`);
    for (const w of e.when.weather ?? []) assert.ok(kinds.includes(w), `${e.id}: unknown weather ${w}`);
    assert.ok(e.when.time || e.when.weather, `${e.id} would always be on`);
    checkEffects(e.effects, e.id);
  }
  // every event can actually happen (its condition is reachable on some map at some time)
  for (const e of events) {
    let seen = false;
    for (let f = 0; f < 1 && !seen; f += 0.01) {
      for (const w of kinds) if (world.activeEvents(world.timeOfDay(at(f)).phase, w, e.maps[0]).some((x) => x.id === e.id)) seen = true;
    }
    assert.ok(seen, `${e.id} can never trigger`);
  }
});

test('events run only on their maps and only under their conditions', () => {
  const seed = 9;
  const night = at(0.9);
  assert.ok(world.state(night, { seed, mapId: 'lake' }).events.includes('moonlit_waters'));
  assert.ok(world.state(night, { seed, mapId: 'ocean' }).events.includes('moonlit_waters'));
  const dusk = at(0.68);
  assert.ok(world.state(dusk, { seed, mapId: 'lake' }).events.includes('golden_hour'));
  assert.ok(!world.state(dusk, { seed, mapId: 'ocean' }).events.includes('golden_hour'), 'golden hour is a lake event');
  const storm = whenWeather('storm', seed);
  assert.ok(world.state(storm, { seed, mapId: 'ocean' }).events.includes('storm_surge'));
  assert.ok(!world.state(storm, { seed, mapId: 'lake' }).events.includes('storm_surge'), 'storm surge is a sea event');
  const clearDay = whenWeather('clear', seed, at(0.3));
  const tod = world.timeOfDay(clearDay).phase;
  if (tod === 'day') assert.deepEqual(world.state(clearDay, { seed, mapId: 'lake' }).events, []);
});

test('state() combines time, weather and events: rarity odds multiply, bite speed multiplies and is clamped', () => {
  const seed = 3;
  const t = whenWeather('storm', seed, at(0.9) - (at(0.9) % conditions.weatherSlotMs));
  // find a stormy night so several sources stack
  let stormyNight = null;
  for (let day = 0; day < 400 && stormyNight === null; day++) {
    const candidate = day * DAY + at(0.9);
    if (world.weatherAt(candidate, seed) === 'storm') stormyNight = candidate;
  }
  assert.ok(stormyNight !== null && t >= 0);
  const s = world.state(stormyNight, { seed, mapId: 'ocean' });
  assert.deepEqual([s.time, s.weather], ['night', 'storm']);
  assert.deepEqual(s.events.sort(), ['moonlit_waters', 'storm_surge']);
  // legendary: night(1) x storm(1) x moonlit(1.6) x surge(2) = 3.2
  assert.ok(Math.abs(s.modifiers.rarityModifier.legendary - 1.6 * 2) < 1e-9);
  // epic: night 1.2 x storm 1.4 x moonlit 1.4 x surge 1.6
  assert.ok(Math.abs(s.modifiers.rarityModifier.epic - 1.2 * 1.4 * 1.4 * 1.6) < 1e-9);
  assert.equal(s.modifiers.rarityModifier.common, 1);
  // bite speed: 1.1 x 0.65 x 0.6 = 0.429, within the clamp
  assert.ok(Math.abs(s.modifiers.biteSpeed - 1.1 * 0.65 * 0.6) < 1e-9);
  assert.ok(s.modifiers.biteSpeed >= BITE_SPEED_RANGE[0]);

  // a plain, clear day changes nothing
  let plain = null;
  for (let day = 0; day < 400 && plain === null; day++) {
    const c = day * DAY + at(0.3);
    if (world.weatherAt(c, seed) === 'clear') plain = c;
  }
  const calm = world.state(plain, { seed, mapId: 'lake' });
  assert.deepEqual(calm.modifiers, { rarityModifier: { common: 1, rare: 1, epic: 1, legendary: 1 }, biteSpeed: 1 });

  // an absurd stack is capped
  const huge = createWorld({ conditions: { ...conditions, weather: { ...conditions.weather, storm: { biteSpeed: 0.1 } } }, events });
  assert.equal(huge.state(stormyNight, { seed, mapId: 'ocean' }).modifiers.biteSpeed, BITE_SPEED_RANGE[0]);
});

test('night-only creatures: the boss only bites at dusk and night, and a pool never ends up empty', () => {
  const boss = byId('nautilus');
  for (const [phase, expected] of [['dawn', false], ['day', false], ['dusk', true], ['night', true]]) {
    assert.equal(speciesAvailable(boss, { time: phase, weather: 'clear' }), expected, phase);
  }
  assert.equal(speciesAvailable(byId('minnow'), { time: 'night', weather: 'storm' }), true, 'ordinary fish always bite');
  assert.equal(speciesAvailable(boss, null), true, 'no world = no filtering');

  const sessions = new FishingSessions({ spots, species, behaviours, rng: (() => { let s = 1; return () => ((s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296); })() });
  const abyss = spot('abyss');
  for (const phase of ['dawn', 'day', 'dusk', 'night']) {
    let sawBoss = false;
    for (let i = 0; i < 4000; i++) {
      const c = sessions.rollCatch(abyss, null, { time: phase, weather: 'clear' });
      assert.ok(abyss.pool.includes(c.speciesId));
      if (c.speciesId === 'nautilus') sawBoss = true;
    }
    assert.equal(sawBoss, phase === 'dusk' || phase === 'night', `boss in the abyss at ${phase}`);
  }
});

// ---------------- the world inside the fishing rules ----------------

function sessionsWith(conditionsFor, { rng, config = {} } = {}) {
  let t = 0;
  const events = [];
  const timers = [];
  const s = new FishingSessions({
    spots, species, behaviours, rng: rng ?? (() => 0.5),
    config,
    emit: (pid, event, payload) => events.push({ pid, event, ...payload }),
    hooks: { conditions: conditionsFor },
    setTimer: (fn, ms) => { timers.push({ fn, ms }); return timers.length - 1; },
    clearTimer: () => {},
  });
  return { s, events, timers, now: () => t };
}
const neutral = { time: 'day', weather: 'clear', events: [], modifiers: { rarityModifier: { common: 1, rare: 1, epic: 1, legendary: 1 }, biteSpeed: 1 } };

test('weather changes how fast fish bite; the bite is never absurdly quick', () => {
  const biteDelay = (state, rolls) => {
    const { s, timers } = sessionsWith(() => state, { rng: (() => { let i = 0; return () => rolls[i++ % rolls.length]; })() });
    const sp = spot('west');
    s.cast('a', { spotId: 'west', power: 0.5, x: sp.x, y: sp.y });
    return timers[0].ms;
  };
  const rolls = [0.5, 0.5, 0.5, 0.5, 0.5, 0.5]; // bite delay = 3000 + 0.5 * 7000 = 6500
  assert.equal(biteDelay(neutral, rolls), 6500);
  assert.equal(biteDelay({ ...neutral, modifiers: { ...neutral.modifiers, biteSpeed: 0.5 } }, rolls), 3250);
  assert.equal(biteDelay({ ...neutral, modifiers: { ...neutral.modifiers, biteSpeed: 1.3 } }, rolls), 8450);
  assert.ok(biteDelay({ ...neutral, modifiers: { ...neutral.modifiers, biteSpeed: 0.001 } }, [0, 0, 0, 0, 0, 0]) >= FISHING.BITE_MIN_MS * 0.5, 'floor');
});

test('weather and events shift the rarity odds on top of the bait', () => {
  const odds = (state) => {
    let seed = 4;
    const rng = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);
    const { s } = sessionsWith(() => state, { rng });
    const tip = spot('dock_tip');
    const out = { common: 0, rare: 0, epic: 0, legendary: 0 };
    const mod = state.modifiers.rarityModifier;
    for (let i = 0; i < 30000; i++) out[byId(s.rollCatch(tip, mod, state).speciesId).rarity]++;
    return Object.fromEntries(Object.entries(out).map(([k, v]) => [k, v / 30000]));
  };
  const calm = odds(neutral);
  const goldenHour = odds({ ...neutral, time: 'dusk', modifiers: { ...neutral.modifiers, rarityModifier: { common: 1, rare: 1.2, epic: 2, legendary: 1.5 } } });
  assert.ok(goldenHour.epic > calm.epic * 1.6, `epic ${calm.epic} -> ${goldenHour.epic}`);
  assert.ok(goldenHour.common < calm.common);
  for (const o of [calm, goldenHour]) assert.ok(Math.abs(Object.values(o).reduce((a, b) => a + b, 0) - 1) < 1e-9);
});

test('a cast takes the world and the bait into account together, and the conditions come from the caster\'s map', () => {
  const asked = [];
  const { s } = sessionsWith((pid, mapId) => {
    asked.push([pid, mapId]);
    return neutral;
  });
  const sp = spot('west');
  s.cast('a', { spotId: 'west', power: 0.5, x: sp.x, y: sp.y });
  const zone = spot('reef');
  s.cast('b', { spotId: 'reef', power: 0.5, x: zone.x, y: zone.y, facing: 'down' });
  assert.deepEqual(asked, [['a', 'lake'], ['b', 'ocean']]);
});

// ---------------- sea zones ----------------

test('every sea zone is open water a boat can reach, with a real fish pool', () => {
  assert.ok(zonesOf().length >= 4);
  for (const z of zonesOf()) {
    assert.ok(['ocean', 'frost'].includes(z.map));
    const sea = MAPS[z.map];
    assert.ok(z.r >= 50 && z.r <= 120, `${z.id} radius`);
    assert.equal(isBlocked(hullRect(z.x, z.y), sea), false, `${z.id} centre is blocked`);
    assert.ok(z.x - z.r >= 0 && z.x + z.r <= sea.width && z.y - z.r >= 0 && z.y + z.r <= sea.height, `${z.id} leaves the map`);
    assert.ok(z.pool.every((id) => byId(id)?.region === z.map), `${z.id} has a fish from another region`);
  }
  for (const [map, boss] of [['ocean', 'nautilus'], ['frost', 'auroraray']]) {
    const legendary = zonesOf().filter((z) => z.legendary && z.map === map);
    assert.equal(legendary.length, 1, `${map}: one legendary spot`);
    assert.ok(legendary[0].pool.includes(boss), 'and the boss lives there');
  }
  assert.equal(spots.filter((x) => x.pool.includes('nautilus')).length, 1, 'only there');
});
function zonesOf() {
  return spots.filter((s) => s.type === 'zone');
}

test('casting from a boat: any direction inside the zone, from the boat\'s position, into water', () => {
  const z = spot('open_sea');
  const make = () => sessionsWith(() => neutral).s;
  const r = make().cast('a', { spotId: 'open_sea', power: 0.5, x: z.x + 20, y: z.y - 10, facing: 'left', mapId: 'ocean' });
  assert.equal(r.ok, true);
  assert.equal(r.session.facing, 'left', 'the bobber goes the way the boat points');
  assert.equal(r.session.mapId, 'ocean');
  assert.ok(r.session.bobber.x < z.x + 20 && Math.abs(r.session.bobber.y - (z.y - 10)) < 1e-9);
  for (const facing of ['up', 'down', 'left', 'right']) assert.equal(make().cast('a', { spotId: 'open_sea', power: 1, x: z.x, y: z.y, facing }).ok, true, facing);
});

test('casting from a boat is refused when it should be', () => {
  const z = spot('open_sea');
  const make = () => sessionsWith(() => neutral).s;
  const base = { spotId: 'open_sea', power: 0.5, x: z.x, y: z.y, facing: 'up', mapId: 'ocean' };
  assert.equal(make().cast('a', { ...base, facing: undefined }).error, 'BAD_FACING');
  assert.equal(make().cast('a', { ...base, facing: 'sideways' }).error, 'BAD_FACING');
  assert.equal(make().cast('a', { ...base, x: z.x + z.r + 30 }).error, 'TOO_FAR', 'outside the zone');
  assert.equal(make().cast('a', { ...base, x: z.x + z.r - 5 }).ok, true, 'just inside');
  assert.equal(make().cast('a', { ...base, mapId: 'lake' }).error, 'WRONG_MAP', 'a lake player cannot fish a sea zone');
  const lakeSpot = spot('west');
  assert.equal(make().cast('a', { spotId: 'west', power: 0.5, x: lakeSpot.x, y: lakeSpot.y, mapId: 'ocean' }).error, 'WRONG_MAP');
  // aiming a cast at an island: the bobber would land on land
  const shoals = spot('shoals');
  assert.equal(make().cast('a', { spotId: 'shoals', power: 0.5, x: 720, y: 470, facing: 'down', mapId: 'ocean' }).error, 'BAD_CAST');
  assert.equal(make().cast('a', { spotId: 'shoals', power: 0.5, x: 720, y: 470, facing: 'up', mapId: 'ocean' }).ok, true);
  assert.ok(shoals);
});

test('the boss: landing it is announced as a boss catch (and as a legendary), carrying its flag', () => {
  const events = [];
  let now = 0;
  const abyss = spot('abyss');
  let i = 0;
  const rolls = [0.9999, 0.9999, 0.5, 0.123, 0.5, 0]; // legendary -> the boss, mid weight
  const s = new FishingSessions({
    spots, species, behaviours, now: () => now, rng: () => rolls[i++ % rolls.length],
    emit: (pid, event, payload) => events.push({ event, ...payload }),
    hooks: { conditions: () => ({ ...neutral, time: 'night' }), gear: () => ({ rod: { reelPower: 23 }, line: { tensionBonus: 0.6, maxWeight: 60 }, bait: { rarityModifier: {} } }) },
    setTimer: (fn) => fn, clearTimer: () => {},
  });
  const res = s.cast('a', { spotId: 'abyss', power: 0.5, x: abyss.x, y: abyss.y, facing: 'up' });
  const session = s.get('a');
  assert.equal(session.speciesId, 'nautilus');
  s.bite(session);
  s.hook('a', res.session.id);
  const hooked = events.find((e) => e.event === 'hooked');
  assert.equal(hooked.speciesId, 'nautilus');
  assert.deepEqual(hooked.gear, { reelPower: 23, lineStrength: 1.6, maxWeight: 60 });
  // fight it with a patient plan; the log must replay to the same outcome on the server
  const fight = play(byId('nautilus'), bots.tensionWatcher(70), hooked.seed, hooked.gear, hooked.weight);
  now = 600000;
  const out = s.finish('a', res.session.id, fight.toggles);
  assert.equal(out.outcome, fight.sim.outcome);
  const result = events.find((e) => e.event === 'result');
  if (out.outcome === 'caught') {
    assert.equal(result.boss, true);
    assert.equal(result.rarity, 'legendary');
    assert.ok(events.some((e) => e.event === 'rare'), 'a legendary is announced to the room');
  } else {
    assert.equal('boss' in result, false, 'a lost fight is not a boss catch');
  }
});

// ---------------- the boss fight itself ----------------

test('the boss is a gear check: hopeless on starter gear, fair with the best rod and line', () => {
  const nautilus = byId('nautilus');
  const rate = (bot, gear, weight, n = 150) => {
    let c = 0;
    for (let i = 1; i <= n; i++) if (play(nautilus, bot, i * 17, gear, weight).sim.outcome === 'caught') c++;
    return c / n;
  };
  const basic = { reelPower: 14, lineStrength: 1, maxWeight: 6 };
  const mid = { reelPower: 18, lineStrength: 1.25, maxWeight: 15 };
  const best = { reelPower: 23, lineStrength: 1.6, maxWeight: 60 };
  for (const w of [40, 80, 120]) {
    assert.equal(rate(bots.fishWatcher(200), basic, w), 0, `starter gear, ${w} kg`);
    assert.equal(rate(bots.masher, basic, w), 0);
    assert.ok(rate(bots.fishWatcher(200), mid, w) <= 0.1, `mid gear ${w} kg`);
  }
  assert.ok(rate(bots.fishWatcher(200), best, 80) >= 0.3, 'it can be beaten by someone prepared');
  assert.ok(rate(bots.fishWatcher(200), best, 80) <= 0.8, 'but it is not a formality');
  assert.ok(rate(bots.masher, best, 80) <= 0.12, 'and button-mashing is not a strategy');
});

test('the boss gets angrier: after the enrage time its rests are shorter and its pulls hit harder', () => {
  const p = reelParams(byId('nautilus'), behaviours, { reelPower: 23, lineStrength: 1.6, maxWeight: 60 }, 60);
  assert.ok(p.enrage && p.enrage.after > 0 && p.enrage.restScale < 1 && p.enrage.riseScale > 1);

  // Hold the fight steady and measure how long rests last before / after the enrage time.
  const restLength = (afterEnrage) => {
    let total = 0;
    let rests = 0;
    for (let seed = 1; seed <= 200; seed++) {
      const sim = new ReelSim({ ...p, timeout: 1e9 }, seed);
      let restTicks = 0;
      let prev = sim.phase;
      for (let i = 0; i < 60 * 60; i++) {
        sim.step(false);
        sim.tension = 0;
        sim.distance = 50;
        sim.outcome = null;
        const late = sim.time >= p.enrage.after;
        if (late !== afterEnrage) { prev = sim.phase; restTicks = 0; continue; }
        if (sim.phase === 'rest') restTicks++;
        else if (prev === 'rest' && restTicks > 0) { total += restTicks * DT; rests++; restTicks = 0; }
        prev = sim.phase;
      }
    }
    return total / rests;
  };
  const calm = restLength(false);
  const angry = restLength(true);
  assert.ok(angry < calm * 0.8, `rests ${calm.toFixed(2)}s -> ${angry.toFixed(2)}s`);

  const tensionAfter = (reelFrom) => {
    const sim = new ReelSim({ ...p, timeout: 1e9, restMin: 1e6, restMax: 1e6 }, 1); // never pulls: isolate the base rise
    sim.time; // (tick-based clock)
    sim.tick = Math.round(reelFrom * 60);
    const before = sim.tension;
    for (let i = 0; i < 30; i++) sim.step(true);
    return sim.tension - before;
  };
  assert.ok(tensionAfter(p.enrage.after + 1) > tensionAfter(1) * 1.15, 'tension builds faster once enraged');
});

test('boss data is complete: the boss archetype exists and the boss species uses it', () => {
  const b = behaviours.boss;
  assert.ok(b && b.enrage);
  assert.ok(b.startDistance > behaviours.strong.startDistance, 'a boss takes longer to land than a strong fish');
  assert.ok(b.timeout > behaviours.strong.timeout);
  assert.equal(byId('nautilus').behaviour, 'boss');
  assert.equal(byId('nautilus').boss, true);
  assert.equal(species.filter((s) => s.boss).length, 2, 'one boss per sea');
  for (const r of RARITIES) assert.ok(r);
});
