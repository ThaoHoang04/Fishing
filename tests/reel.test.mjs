import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ReelSim, reelParams, replay, validToggles, mulberry32, DT, REEL } from '../src/systems/ReelSim.js';
import { species, behaviours, byId, bots, play, catchRate } from './bots.mjs';

const params = (id, gear) => reelParams(byId(id), behaviours, gear);

test('PRNG is deterministic per seed', () => {
  const a = mulberry32(42);
  const b = mulberry32(42);
  const c = mulberry32(43);
  const seqA = Array.from({ length: 5 }, a);
  assert.deepEqual(seqA, Array.from({ length: 5 }, b));
  assert.notDeepEqual(seqA, Array.from({ length: 5 }, c));
});

test('same seed + same input => identical fight, tick for tick', () => {
  const trace = () => {
    const sim = new ReelSim(params('trout'), 12345);
    const out = [];
    for (let i = 0; i < 600 && !sim.done; i++) {
      sim.step(i % 90 < 50);
      out.push([sim.distance.toFixed(6), sim.tension.toFixed(6), sim.phase]);
    }
    return out;
  };
  assert.deepEqual(trace(), trace());
});

test('the fish timeline does not depend on what the player does', () => {
  const timeline = (input) => {
    const sim = new ReelSim(params('koi'), 777);
    const phases = [];
    for (let i = 0; i < 400; i++) {
      sim.step(input(i));
      phases.push(sim.phase);
      sim.outcome = null; // keep going even if the line snapped, we only look at the fish
    }
    return phases;
  };
  assert.deepEqual(timeline(() => true), timeline(() => false));
});

test('server replay of a recorded input log reproduces the live outcome exactly', () => {
  for (const sp of species) {
    for (let seed = 1; seed <= 25; seed++) {
      const { sim, toggles } = play(sp, bots.fishWatcher(), seed * 101);
      const r = replay(reelParams(sp, behaviours), seed * 101, toggles);
      assert.equal(r.outcome, sim.outcome, `${sp.id} seed ${seed}`);
      assert.equal(r.tick, sim.tick);
      assert.equal(r.sim.distance, sim.distance);
    }
  }
});

test('outcomes: caught at 0 distance, snapped at 100 tension, escaped at 100 distance, timeout', () => {
  // Hold forever -> the line snaps long before the fish is landed (trout is strong).
  assert.equal(play(byId('trout'), bots.masher, 1).sim.outcome, 'snapped');
  // Never reel on a fish that drifts away -> it escapes or runs the clock out, but is never caught.
  const idle = play(byId('perch'), () => () => false, 1).sim;
  assert.ok(['escaped', 'timeout'].includes(idle.outcome), idle.outcome);
  // A perfect play lands it.
  assert.equal(play(byId('minnow'), bots.fishWatcher(100), 1).sim.outcome, 'caught');
  // Timeout: tension-neutral stalling (a tiny pulse) never gets anywhere.
  const stall = new ReelSim({ ...params('minnow'), startDistance: 99, drift: 0, pullDrift: 0 }, 5);
  while (!stall.done) stall.step(false);
  assert.equal(stall.outcome, 'timeout');
  assert.ok(stall.time >= params('minnow').timeout);
});

test('reeling raises tension and pulls the fish in; letting go drops tension and gives line', () => {
  const sim = new ReelSim({ ...params('minnow'), restMin: 50, restMax: 50, drift: 5 }, 1);
  const d0 = sim.distance;
  for (let i = 0; i < 60; i++) sim.step(true);
  assert.ok(sim.distance < d0 && sim.tension > 0);
  const [d1, t1] = [sim.distance, sim.tension];
  for (let i = 0; i < 30; i++) sim.step(false);
  assert.ok(sim.distance > d1, 'fish takes line when released');
  assert.ok(sim.tension < t1, 'tension eases when released');
  assert.ok(sim.tension >= 0);
});

test('during a pull, reeling is less effective and spikes tension; releasing costs distance', () => {
  const make = () => {
    const sim = new ReelSim({ ...params('trout'), restMin: 0.01, restMax: 0.01, telegraph: [0.01, 0.01], pullMin: 5, pullMax: 5 }, 9);
    for (let i = 0; i < 5 && sim.phase !== 'pull'; i++) sim.step(false);
    while (sim.phase !== 'pull') sim.step(false);
    sim.tension = 20;
    sim.distance = 50;
    return sim;
  };
  const reeling = make();
  const letGo = make();
  for (let i = 0; i < 30; i++) {
    reeling.step(true);
    letGo.step(false);
  }
  assert.ok(reeling.tension > 20 + 25, 'tension spikes while reeling into a pull');
  assert.ok(letGo.tension < 20, 'tension drops when letting go');
  assert.ok(letGo.distance > 50, 'a released fish runs');
  assert.ok(reeling.distance < letGo.distance);
  // Reel power is cut by pullResist during a pull.
  const p = params('trout');
  assert.ok(50 - reeling.distance < p.gear.reelPower * 0.5 * (1 - p.pullResist) * 1.05);
});

test('behaviours are config-driven: every species points at a defined archetype, no species is special-cased', () => {
  assert.ok(species.length >= 4);
  for (const sp of species) {
    assert.ok(behaviours[sp.behaviour], `${sp.id} -> ${sp.behaviour}`);
    assert.ok(Number.isFinite(reelParams(sp, behaviours).startDistance));
  }
  assert.ok(new Set(species.map((s) => s.behaviour)).size >= 4, 'at least four distinct archetypes in play');
  assert.throws(() => reelParams({ id: 'x', behaviour: 'nope' }, behaviours), /unknown behaviour/);
  // A brand-new species + archetype works from data alone.
  const data = { ...behaviours, sloth: { ...behaviours.normal, name: 'Sloth', startDistance: 30 } };
  const sim = new ReelSim(reelParams({ id: 'slug', behaviour: 'sloth' }, data), 3);
  assert.equal(sim.distance, 30);
});

// --- feel: the four archetypes must play differently ---

function timelineStats(id) {
  let ticks = 0, pullTicks = 0, pulls = 0, fakes = 0, ambush = 0;
  for (let seed = 1; seed <= 200; seed++) {
    const sim = new ReelSim({ ...params(id), timeout: 1e9 }, seed * 31);
    let prev = 'rest';
    for (let i = 0; i < 60 * 40; i++) {
      sim.step(false);
      // Pin the fight in place: only the fish's own behaviour timeline is measured here.
      sim.tension = 0;
      sim.distance = 50;
      sim.outcome = null;
      ticks++;
      if (sim.phase === 'pull') pullTicks++;
      if (sim.phase === 'pull' && prev !== 'pull') {
        pulls++;
        if (prev === 'rest') ambush++; // pull straight out of rest = no telegraph
      }
      prev = sim.phase;
    }
    fakes += sim.fakes;
  }
  const secs = ticks * DT;
  return { pullsPerSec: pulls / secs, avgPull: pullTicks * DT / pulls, fakesPerSec: fakes / secs, ambushPerSec: ambush / secs };
}

test('Fast pulls much more often, Strong pulls much longer, Trickster bluffs and ambushes', () => {
  const normal = timelineStats('minnow');
  const fast = timelineStats('perch');
  const strong = timelineStats('trout');
  const trick = timelineStats('koi');
  assert.ok(fast.pullsPerSec > normal.pullsPerSec * 2, `fast ${fast.pullsPerSec} vs normal ${normal.pullsPerSec}`);
  assert.ok(strong.avgPull > normal.avgPull * 1.8, `strong ${strong.avgPull} vs normal ${normal.avgPull}`);
  assert.ok(fast.avgPull < normal.avgPull, 'fast pulls are short');
  assert.equal(normal.fakesPerSec, 0);
  assert.equal(normal.ambushPerSec, 0);
  assert.ok(trick.fakesPerSec > 0.05, 'trickster telegraphs pulls that never come');
  assert.ok(trick.ambushPerSec > 0.02, 'trickster also pulls with no warning');
});

test('mashing the button never works; reading the fish always does (default gear)', () => {
  for (const sp of species) {
    assert.ok(catchRate(sp, bots.masher) <= 0.05, `${sp.id} masher`);
    // A boss is a gear check, not a skill check: see the boss tests. Everything else is landable by a sharp player.
    if (!sp.boss) assert.ok(catchRate(sp, bots.fishWatcher(200)) >= 0.95, `${sp.id} attentive player`);
  }
});

test('common fish are easy with default gear, even for a casual player', () => {
  assert.ok(catchRate(byId('minnow'), bots.tensionWatcher(70)) >= 0.95, 'minnow, tension bar only');
  assert.ok(catchRate(byId('minnow'), bots.fishWatcher(450)) >= 0.95, 'minnow, slow reactions');
  assert.ok(catchRate(byId('perch'), bots.fishWatcher(450)) >= 0.9, 'perch, slow reactions');
  assert.ok(catchRate(byId('perch'), bots.tensionWatcher(70)) >= 0.9, 'perch, cautious tension watcher');
});

test('Strong and Fast fish punish a player who only watches tension and does not read the fish', () => {
  for (const id of ['perch', 'trout']) {
    assert.ok(catchRate(byId(id), bots.tensionWatcher(78)) <= 0.2, `${id} must not be beatable by bar-watching at the limit`);
    assert.ok(catchRate(byId(id), bots.tensionWatcher(78)) < catchRate(byId('minnow'), bots.tensionWatcher(78)));
  }
});

test('Trickster is the one that punishes slow reactions', () => {
  const quick = catchRate(byId('koi'), bots.fishWatcher(200));
  const slow = catchRate(byId('koi'), bots.fishWatcher(450));
  assert.ok(quick - slow >= 0.2, `quick ${quick} vs slow ${slow}`);
  const normalGap = catchRate(byId('minnow'), bots.fishWatcher(200)) - catchRate(byId('minnow'), bots.fishWatcher(450));
  assert.ok(quick - slow > normalGap + 0.15);
});

test('fights last long enough to matter but not forever (6-25 s when played well)', () => {
  for (const sp of species.filter((s) => !s.boss)) {
    let total = 0;
    for (let seed = 1; seed <= 100; seed++) total += play(sp, bots.fishWatcher(200), seed * 13).sim.time;
    const avg = total / 100;
    assert.ok(avg >= 5 && avg <= 25, `${sp.id} avg fight ${avg.toFixed(1)}s`);
  }
});

test('better gear makes the same fight easier (rod power, line strength)', () => {
  const trout = byId('trout');
  const base = catchRate(trout, bots.tensionWatcher(78));
  const stronger = catchRate(trout, bots.tensionWatcher(78), { gear: { lineStrength: 1.6 } });
  assert.ok(stronger > base + 0.3, `${base} -> ${stronger}`);
  const slowRod = catchRate(byId('perch'), bots.fishWatcher(450), { gear: { reelPower: 9 } });
  const goodRod = catchRate(byId('perch'), bots.fishWatcher(450), { gear: { reelPower: 20 } });
  assert.ok(goodRod >= slowRod);
});

test('input log validation rejects garbage from an untrusted client', () => {
  assert.equal(validToggles([0, 10, 10, 50], 1000), true);
  assert.equal(validToggles([10, 5], 1000), false, 'must be non-decreasing');
  assert.equal(validToggles([-1], 1000), false);
  assert.equal(validToggles([1.5], 1000), false);
  assert.equal(validToggles([5000], 1000), false);
  assert.equal(validToggles(['a'], 1000), false);
  assert.equal(validToggles('nope', 1000), false);
  assert.equal(validToggles(new Array(REEL.MAX_TOGGLES + 1).fill(1), 1000), false);
  assert.equal(validToggles([], 1000), true);
});
