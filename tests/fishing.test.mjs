import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import FishingSessions from '../src/systems/FishingSessions.js';
import { FISHING, landingPoint } from '../src/systems/FishingRules.js';
import { isWaterAt } from '../src/systems/Collision.js';
import { play, bots, byId } from './bots.mjs';

const readJson = (rel) => JSON.parse(readFileSync(new URL(rel, import.meta.url), 'utf8'));
const spots = readJson('../src/data/spots.json');
const species = readJson('../src/data/fish.json');
const behaviours = readJson('../src/data/behaviours.json');

// Manual clock: timers only fire when the test advances time.
function harness({ rng = Math.random } = {}) {
  let now = 0;
  const timers = new Map();
  let nextTimer = 1;
  const events = [];
  const sessions = new FishingSessions({
    spots, species, behaviours, rng, now: () => now,
    emit: (pid, event, payload) => events.push({ pid, event, ...payload }),
    setTimer: (fn, ms) => { timers.set(nextTimer, { at: now + ms, fn }); return nextTimer++; },
    clearTimer: (id) => timers.delete(id),
  });
  const advance = (ms) => {
    const target = now + ms;
    for (;;) {
      const due = [...timers].filter(([, t]) => t.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      now = due[1].at;
      timers.delete(due[0]);
      due[1].fn();
    }
    now = target;
  };
  const names = (pid) => events.filter((e) => e.pid === pid && e.event !== 'state').map((e) => e.event);
  const states = (pid) => events.filter((e) => e.pid === pid && e.event === 'state').map((e) => e.state);
  return { sessions, advance, events, names, states, timers, clock: () => now };
}

const spot = (id) => spots.find((s) => s.id === id);
const lakeSpots = spots.filter((s) => !s.map || s.map === 'lake'); // fixed standing points on the lake and pier
const zones = spots.filter((s) => s.type === 'zone'); // circles of sea, fished from a boat
const at = (id, extra = {}) => ({ spotId: id, power: 0.5, x: spot(id).x, y: spot(id).y, ...extra });

test('every lake spot has a valid water landing across the whole power range', () => {
  for (const s of lakeSpots) {
    for (const power of [FISHING.MIN_POWER, 0.25, 0.5, 0.75, 1]) {
      const p = landingPoint(s, power);
      assert.equal(isWaterAt(p.x, p.y), true, `${s.id} @ power ${power} lands at ${p.x},${p.y}`);
    }
  }
});

test('cast -> bite -> hook succeeds and reveals species + seed only at that point', () => {
  const h = harness({ rng: () => 0.3 });
  const res = h.sessions.cast('a', at('north_west'));
  assert.equal(res.ok, true);
  assert.equal('speciesId' in res.session, false, 'species must not leak at cast time');
  h.advance(5200); // rng 0.3 -> bite at 3000 + 0.3 * 7000 = 5100ms
  assert.deepEqual(h.names('a'), ['bite']);
  assert.equal(h.sessions.hook('a', res.session.id).ok, true);
  const hooked = h.events.find((e) => e.event === 'hooked');
  assert.ok(species.some((f) => f.id === hooked.speciesId));
  assert.ok(Number.isInteger(hooked.seed));
  assert.deepEqual(h.states('a'), ['wait', 'bite', 'hooked']);
});

test('bite delay is within 3-10s and the hook window within 1-1.5s', () => {
  for (const r of [0, 0.5, 0.9999]) {
    const h = harness({ rng: () => r });
    h.sessions.cast('a', at('west'));
    h.advance(FISHING.BITE_MIN_MS - 1);
    assert.deepEqual(h.names('a'), [], 'no bite before 3s');
    h.advance(FISHING.BITE_MAX_MS);
    const bite = h.events.find((e) => e.event === 'bite');
    assert.ok(bite.windowMs >= FISHING.HOOK_MIN_MS && bite.windowMs <= FISHING.HOOK_MAX_MS, `window ${bite.windowMs}`);
  }
  const h = harness({ rng: () => 0 });
  h.sessions.cast('a', at('west'));
  h.advance(FISHING.BITE_MIN_MS);
  assert.deepEqual(h.names('a'), ['bite'], 'bite exactly at the minimum delay');
  const h2 = harness({ rng: () => 0.9999 });
  h2.sessions.cast('a', at('west'));
  h2.advance(FISHING.BITE_MAX_MS - 5);
  assert.deepEqual(h2.names('a'), []);
  h2.advance(5);
  assert.deepEqual(h2.names('a'), ['bite']);
});

test('missing the hook window ends the session with a miss', () => {
  const h = harness({ rng: () => 0 });
  const { session } = h.sessions.cast('a', at('east'));
  h.advance(FISHING.BITE_MIN_MS);
  h.advance(FISHING.HOOK_MIN_MS + FISHING.HOOK_SLACK_MS);
  assert.deepEqual(h.names('a'), ['bite', 'miss']);
  assert.equal(h.sessions.get('a'), null);
  assert.equal(h.sessions.hook('a', session.id).error, 'NO_SESSION');
  assert.equal(h.states('a').at(-1), 'idle');
  assert.equal(h.sessions.cast('a', at('east')).ok, true, 'can cast again after a miss');
});

test('hooking inside the slack after the window still counts (network latency)', () => {
  const h = harness({ rng: () => 0 });
  const { session } = h.sessions.cast('a', at('east'));
  h.advance(FISHING.BITE_MIN_MS + FISHING.HOOK_MIN_MS + FISHING.HOOK_SLACK_MS - 10);
  assert.equal(h.sessions.hook('a', session.id).ok, true);
  assert.deepEqual(h.names('a'), ['bite', 'hooked']);
});

test('hooking before the bite is an "early" failure and clears the session', () => {
  const h = harness();
  const { session } = h.sessions.cast('a', at('north_east'));
  h.advance(1000);
  assert.equal(h.sessions.hook('a', session.id).ok, true);
  assert.deepEqual(h.events.find((e) => e.event === 'fail'), { pid: 'a', event: 'fail', id: session.id, reason: 'early' });
  assert.equal(h.sessions.get('a'), null);
  assert.equal(h.timers.size, 0, 'no timer may survive the failure (a stale bite would corrupt the next cast)');
  h.advance(FISHING.BITE_MAX_MS * 2);
  assert.deepEqual(h.names('a'), ['fail']);
});

test('spamming cast does not create a second session', () => {
  const h = harness();
  assert.equal(h.sessions.cast('a', at('west')).ok, true);
  for (let i = 0; i < 5; i++) assert.equal(h.sessions.cast('a', at('west')).error, 'ALREADY_FISHING');
  assert.equal(h.timers.size, 1);
  assert.equal(h.sessions.active.size, 1);
});

test('cancel returns to a clean idle state with no leftover timers', () => {
  const h = harness();
  h.sessions.cast('a', at('south_east'));
  h.advance(2000);
  h.sessions.cancel('a');
  assert.equal(h.timers.size, 0);
  assert.equal(h.sessions.get('a'), null);
  assert.equal(h.states('a').at(-1), 'idle');
  h.advance(FISHING.BITE_MAX_MS * 2);
  assert.deepEqual(h.names('a'), [], 'a cancelled session must never bite');
  assert.equal(h.sessions.cast('a', at('south_east')).ok, true);
  h.sessions.cancel('nobody'); // harmless
});

test('player A missing the hook does not affect player B (independent sessions)', () => {
  const h = harness({ rng: () => 0 });
  const a = h.sessions.cast('a', at('west'));
  const b = h.sessions.cast('b', at('east'));
  assert.ok(a.ok && b.ok);
  assert.notEqual(a.session.id, b.session.id);
  h.advance(FISHING.BITE_MIN_MS);
  assert.equal(h.sessions.hook('b', b.session.id).ok, true);
  h.advance(FISHING.HOOK_MAX_MS + FISHING.HOOK_SLACK_MS);
  assert.deepEqual(h.names('a'), ['bite', 'miss']);
  assert.deepEqual(h.names('b'), ['bite', 'hooked']);
  assert.equal(h.sessions.hook('a', a.session.id).error, 'NO_SESSION');
  assert.equal(h.sessions.get('b').state, 'hooked');
});

test('two players get different bite times when the rolls differ', () => {
  const rolls = [0.1, 0.1, 0.1, 0.1, 0.1, 0.1, /* 2nd cast: */ 0.1, 0.1, 0.1, 0.1, 0.1, 0.8]; // per cast: rarity, species, weight, seed, window, bite delay
  let i = 0;
  const h = harness({ rng: () => rolls[i++] });
  h.sessions.cast('a', at('west'));
  h.sessions.cast('b', at('east'));
  h.advance(FISHING.BITE_MIN_MS + 1500);
  assert.deepEqual(h.names('a'), ['bite']);
  assert.deepEqual(h.names('b'), [], 'B has not bitten yet');
});

test('a hooked session blocks new casts until finished, then expires by TTL if abandoned', () => {
  const h = harness({ rng: () => 0 });
  const { session } = h.sessions.cast('a', at('west'));
  h.advance(FISHING.BITE_MIN_MS);
  h.sessions.hook('a', session.id);
  assert.equal(h.sessions.cast('a', at('west')).error, 'ALREADY_FISHING');
  h.advance(FISHING.HOOKED_TTL_MS);
  assert.equal(h.sessions.get('a'), null);
  assert.equal(h.sessions.cast('a', at('west')).ok, true);
});

test('rejects casts that are too far, from unknown spots, or with bad power', () => {
  const h = harness();
  assert.equal(h.sessions.cast('a', at('west', { x: 300, y: 300 })).error, 'TOO_FAR');
  assert.equal(h.sessions.cast('a', at('west', { x: NaN })).error, 'TOO_FAR');
  assert.equal(h.sessions.cast('a', { spotId: 'nowhere', power: 0.5, x: 0, y: 0 }).error, 'BAD_SPOT');
  assert.equal(h.sessions.cast('a', at('west', { power: NaN })).error, 'BAD_POWER');
  assert.equal(h.sessions.cast('a', at('west', { x: spot('west').x - 25 })).ok, true, 'within radius + tolerance');
  assert.equal(h.sessions.active.size, 1);
});

test('out-of-range power is clamped, never lands outside the water', () => {
  for (const power of [-5, 0, 1, 99]) {
    const h = harness();
    const res = h.sessions.cast('a', at('dock_tip', { power }));
    assert.equal(res.ok, true);
    assert.equal(isWaterAt(res.session.bobber.x, res.session.bobber.y), true);
  }
});

test('hooking with a stale session id is ignored', () => {
  const h = harness({ rng: () => 0 });
  const first = h.sessions.cast('a', at('west'));
  h.sessions.cancel('a');
  const second = h.sessions.cast('a', at('west'));
  assert.equal(h.sessions.hook('a', first.session.id).error, 'NO_SESSION');
  assert.equal(h.sessions.get('a').id, second.session.id);
});

// Seeded generator so distribution tests are repeatable.
const lcg = (seed) => () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);
// Scripted rng: returns the given values first, then falls back to a seeded stream.
const scripted = (values, seed = 99) => {
  const rest = lcg(seed);
  let i = 0;
  return () => (i < values.length ? values[i++] : rest());
};
// Rolls per cast, in order: rarity, species, weight, seed, hook window, bite delay.

test('rollCatch: never a fish outside the spot pool, weight always within the species range', () => {
  const h = harness({ rng: lcg(1) });
  const seen = new Set();
  for (const sp of spots) {
    if (sp.type === 'zone') sp.facing = 'up'; // (only used to cast; rolling does not care)
    for (let i = 0; i < 3000; i++) {
      const c = h.sessions.rollCatch(sp);
      const fish = byId(c.speciesId);
      assert.ok(sp.pool.includes(c.speciesId), `${c.speciesId} is not in the pool of ${sp.id}`);
      assert.ok(c.weight >= fish.minWeight && c.weight <= fish.maxWeight, `${fish.id} ${c.weight}`);
      assert.equal(Math.round(c.weight * 100) / 100, c.weight, 'weights have 2 decimals (kg)');
      seen.add(c.speciesId);
    }
  }
  assert.equal(seen.size, species.length, 'every species can be caught somewhere');
});

test('rollCatch: rarity odds follow the table, re-spread over the rarities a spot actually has', () => {
  const h = harness({ rng: lcg(7) });
  const tally = (spotData, n = 30000) => {
    const out = { common: 0, rare: 0, epic: 0, legendary: 0 };
    for (let i = 0; i < n; i++) out[byId(h.sessions.rollCatch(spotData).speciesId).rarity]++;
    return Object.fromEntries(Object.entries(out).map(([k, v]) => [k, v / n]));
  };
  const deep = tally(spot('dock_tip')); // has all four rarities: 70 / 22 / 7 / 1
  assert.ok(Math.abs(deep.common - 0.7) < 0.015, JSON.stringify(deep));
  assert.ok(Math.abs(deep.rare - 0.22) < 0.015);
  assert.ok(Math.abs(deep.epic - 0.07) < 0.01);
  assert.ok(deep.legendary > 0.004 && deep.legendary < 0.02);
  const shallow = tally(spot('north_west')); // common + rare only: 70 / 92 and 22 / 92
  assert.equal(shallow.epic + shallow.legendary, 0);
  assert.ok(Math.abs(shallow.common - 70 / 92) < 0.015, JSON.stringify(shallow));
});

test('rollCatch: species odds inside a rarity follow catchWeight; weights skew toward the small end', () => {
  const h = harness({ rng: lcg(3) });
  const counts = {};
  const weights = [];
  for (let i = 0; i < 40000; i++) {
    const c = h.sessions.rollCatch(spot('north_east')); // minnow 40, sunfish 30, carp 25 (common)
    counts[c.speciesId] = (counts[c.speciesId] ?? 0) + 1;
    if (c.speciesId === 'carp') weights.push(c.weight);
  }
  assert.ok(counts.minnow > counts.sunfish && counts.sunfish > counts.carp, JSON.stringify(counts));
  const carp = byId('carp');
  const mean = weights.reduce((a, b) => a + b, 0) / weights.length;
  assert.ok(mean < (carp.minWeight + carp.maxWeight) / 2, `mean ${mean} should sit below the midpoint`);
  assert.ok(Math.max(...weights) > carp.maxWeight * 0.8, 'but big ones do happen');
});

test('rollCatch: a scripted roll lands on the expected rarity, species and weight', () => {
  const top = harness({ rng: scripted([0.99, 0.999, 0.999]) }); // highest of everything
  const c = top.sessions.rollCatch(spot('dock_tip'));
  assert.equal(c.speciesId, 'jelly');
  assert.ok(c.weight >= 39.9 && c.weight <= 40, `top roll gives (nearly) the max weight, got ${c.weight}`);
  const low = harness({ rng: scripted([0, 0, 0]) }); // lowest of everything
  const l = low.sessions.rollCatch(spot('dock_tip'));
  assert.deepEqual([l.speciesId, l.weight], ['carp', 1.0]);
});

test('a cast keeps what was rolled: a fish from the pool of the spot it was cast from', () => {
  for (const sp of lakeSpots) {
    const h = harness({ rng: lcg(sp.x) });
    h.sessions.cast('a', { spotId: sp.id, power: 0.5, x: sp.x, y: sp.y });
    const session = h.sessions.get('a');
    const fish = byId(session.speciesId);
    assert.ok(sp.pool.includes(session.speciesId));
    assert.ok(session.weight >= fish.minWeight && session.weight <= fish.maxWeight);
  }
});

// ---- reeling: the server replays the client's recorded input ----
import { TICK_RATE } from '../src/systems/ReelSim.js';

// Advance in small steps until `pid`'s fish bites (the bite time depends on the rolls).
function advanceToBite(h, pid) {
  for (let t = 0; t < FISHING.BITE_MAX_MS + 100 && !h.events.some((e) => e.pid === pid && e.event === 'bite'); t += 10) h.advance(10);
}

// Cast + bite + hook on the harness, returning the species/seed the fish was hooked with.
function hookOne(h, pid = 'a', spotId = 'west') {
  const { session } = h.sessions.cast(pid, at(spotId));
  advanceToBite(h, pid);
  h.sessions.hook(pid, session.id);
  const hooked = h.events.filter((e) => e.event === 'hooked').at(-1);
  return { id: session.id, sp: byId(hooked.speciesId), seed: hooked.seed };
}

test('finish: a genuine recorded fight is confirmed as caught and the session ends cleanly', () => {
  const h = harness({ rng: () => 0 }); // rng 0 -> first species (minnow), seed 0
  const { id, sp, seed } = hookOne(h);
  const { sim, toggles } = play(sp, bots.fishWatcher(), seed);
  assert.equal(sim.outcome, 'caught');
  h.advance(sim.tick / TICK_RATE * 1000); // the fight took this long in real time
  const res = h.sessions.finish('a', id, toggles);
  assert.deepEqual([res.ok, res.outcome], [true, 'caught']);
  const result = h.events.find((e) => e.event === 'result');
  assert.deepEqual({ ...result, weight: undefined }, { pid: 'a', event: 'result', id, outcome: 'caught', speciesId: sp.id, tick: sim.tick, weight: undefined, rarity: sp.rarity, stored: true });
  assert.ok(result.weight >= sp.minWeight && result.weight <= sp.maxWeight, 'the confirmed catch carries its weight');
  assert.equal(h.sessions.get('a'), null);
  assert.equal(h.states('a').at(-1), 'idle');
  assert.equal(h.sessions.cast('a', at('west')).ok, true, 'free to cast again');
});

test('finish: the server decides the outcome, not the client (a masher log cannot be passed off as a catch)', () => {
  const h = harness({ rng: () => 0.9999 }); // top of every roll: the last rare in the spot's pool
  const { id, sp } = hookOne(h);
  assert.equal(sp.behaviour, 'trickster');
  h.advance(30000);
  const res = h.sessions.finish('a', id, [0]); // "held the button from tick 0 forever"
  assert.notEqual(res.outcome, 'caught');
});

test('finish: a catch that happened faster than the fight can last in real time is rejected', () => {
  const h = harness({ rng: () => 0 });
  const { id, sp, seed } = hookOne(h);
  const { sim, toggles } = play(sp, bots.fishWatcher(), seed);
  assert.equal(sim.outcome, 'caught');
  h.advance(300); // only 0.3s of real time for a ~6s fight
  assert.equal(h.sessions.finish('a', id, toggles).outcome, 'invalid');
});

test('finish: malformed logs are rejected and still end the session', () => {
  for (const bad of [[5, 2], [-1], 'x', [1.5], new Array(700).fill(1), null, undefined]) {
    const h = harness({ rng: () => 0 });
    const { id } = hookOne(h);
    assert.equal(h.sessions.finish('a', id, bad).outcome, 'invalid', JSON.stringify(bad)?.slice(0, 20));
    assert.equal(h.sessions.get('a'), null);
  }
});

test('finish: only valid while hooked, only for the current session id, only once', () => {
  const h = harness({ rng: () => 0 });
  const { session } = h.sessions.cast('a', at('west'));
  assert.equal(h.sessions.finish('a', session.id, []).error, 'BAD_STATE', 'cannot finish while still waiting');
  advanceToBite(h, 'a');
  h.sessions.hook('a', session.id);
  assert.equal(h.sessions.finish('a', 'wrong', []).error, 'NO_SESSION');
  assert.equal(h.sessions.finish('b', session.id, []).error, 'NO_SESSION', "another player cannot finish A's fight");
  h.advance(30000);
  assert.equal(h.sessions.finish('a', session.id, []).ok, true);
  assert.equal(h.sessions.finish('a', session.id, []).error, 'NO_SESSION', 'a result cannot be claimed twice');
});

test('finish: two players fight at once and each result is replayed against their own seed', () => {
  const h = harness({ rng: lcg(2024) });
  const a = h.sessions.cast('a', at('west'));
  const b = h.sessions.cast('b', at('east'));
  advanceToBite(h, 'a');
  h.sessions.hook('a', a.session.id);
  advanceToBite(h, 'b');
  h.sessions.hook('b', b.session.id);
  const hookedA = h.events.find((e) => e.event === 'hooked' && e.pid === 'a');
  const hookedB = h.events.find((e) => e.event === 'hooked' && e.pid === 'b');
  assert.notEqual(hookedA.seed, hookedB.seed);
  const fightA = play(byId(hookedA.speciesId), bots.fishWatcher(), hookedA.seed);
  h.advance(fightA.sim.tick / TICK_RATE * 1000);
  assert.equal(h.sessions.finish('a', a.session.id, fightA.toggles).outcome, fightA.sim.outcome);
  assert.equal(h.sessions.get('b').state, 'hooked', "B's fight is untouched");
  const fightB = play(byId(hookedB.speciesId), bots.fishWatcher(), hookedB.seed);
  h.advance(fightB.sim.tick / TICK_RATE * 1000);
  assert.equal(h.sessions.finish('b', b.session.id, fightB.toggles).outcome, fightB.sim.outcome);
});

// ---- rare catch announcement ----
const roll = (rarity, species) => scripted([rarity, species, 0.5, 0.123, 0.5, 0]); // bite at 3 s, fixed seed

function landAFish(h, rolls, spotId = 'dock_right') {
  h.sessions.rng = rolls;
  const { id, sp, seed } = hookOne(h, 'a', spotId);
  const fight = play(sp, bots.fishWatcher(100), seed);
  h.advance((fight.sim.tick / TICK_RATE) * 1000);
  return { id, sp, fight, res: h.sessions.finish('a', id, fight.toggles) };
}

test('rare: landing a Rare or better fish announces it exactly once, with who/what/weight', () => {
  const h = harness();
  const { id, sp, res } = landAFish(h, roll(0.9, 0)); // dock_right: rare -> first rare in the pool = bass
  assert.equal(sp.rarity, 'rare');
  assert.equal(res.outcome, 'caught');
  const rare = h.events.filter((e) => e.event === 'rare');
  assert.equal(rare.length, 1);
  assert.deepEqual({ ...rare[0], weight: 0 }, { pid: 'a', event: 'rare', id, speciesId: sp.id, rarity: 'rare', weight: 0 });
  assert.ok(rare[0].weight >= sp.minWeight && rare[0].weight <= sp.maxWeight);
  assert.equal(h.sessions.finish('a', id, []).error, 'NO_SESSION', 'a second finish cannot re-announce it');
  assert.equal(h.events.filter((e) => e.event === 'rare').length, 1);
});

test('rare: epics and legendaries are announced too; commons are not', () => {
  const epic = harness();
  landAFish(epic, roll(0.97, 0.99)); // dock_right: epic -> koi
  assert.deepEqual(epic.events.filter((e) => e.event === 'rare').map((e) => e.rarity), ['epic']);

  const legendary = harness();
  const { sp } = landAFish(legendary, roll(0.9999, 0.5), 'dock_tip');
  assert.equal(sp.rarity, 'legendary');
  assert.equal(legendary.events.filter((e) => e.event === 'rare').length, 1);

  const common = harness();
  const { res } = landAFish(common, roll(0.1, 0));
  assert.equal(res.outcome, 'caught');
  assert.equal(common.events.filter((e) => e.event === 'rare').length, 0);
});

test('rare: a lost fight, a cancel or an invalid log announce nothing', () => {
  const lost = harness();
  lost.sessions.rng = roll(0.97, 0.5);
  const hookedLost = hookOne(lost, 'a', 'dock_right');
  lost.advance(30000);
  assert.notEqual(lost.sessions.finish('a', hookedLost.id, [0]).outcome, 'caught');
  assert.equal(lost.events.filter((e) => e.event === 'rare').length, 0);

  const quick = harness();
  quick.sessions.rng = roll(0.97, 0.5);
  const hooked = hookOne(quick, 'a', 'dock_right');
  const fight = play(hooked.sp, bots.fishWatcher(100), hooked.seed);
  quick.advance(200); // implausibly fast
  assert.equal(quick.sessions.finish('a', hooked.id, fight.toggles).outcome, 'invalid');
  assert.equal(quick.events.filter((e) => e.event === 'rare').length, 0);

  const cancelled = harness();
  cancelled.sessions.rng = roll(0.97, 0.5);
  hookOne(cancelled, 'a', 'dock_right');
  cancelled.sessions.cancel('a');
  assert.equal(cancelled.events.filter((e) => e.event === 'rare').length, 0);
});

test('rare: a failed fight never carries weight or rarity', () => {
  const h = harness();
  h.sessions.rng = roll(0.97, 0.5);
  const { id } = hookOne(h, 'a', 'dock_right');
  h.advance(30000);
  h.sessions.finish('a', id, [0]);
  const result = h.events.find((e) => e.event === 'result');
  assert.equal('weight' in result, false);
  assert.equal('rarity' in result, false);
});
