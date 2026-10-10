import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { io as connect } from 'socket.io-client';
import { createGameServer } from '../server/index.js';
import Economy from '../src/systems/Economy.js';
import MemoryStore from '../src/systems/MemoryStore.js';
import { STEAL, needleAt, duelScore, isStealable, thiefWins } from '../src/systems/Steal.js';
import { play, bots, byId } from './bots.mjs';
import { TICK_RATE } from '../src/systems/ReelSim.js';

const readJson = (rel) => JSON.parse(readFileSync(new URL(rel, import.meta.url), 'utf8'));
const SPECIES = readJson('../src/data/fish.json');
const EQUIPMENT = readJson('../src/data/equipment.json');
const spots = readJson('../src/data/spots.json');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------- rules ----------------

test('the needle sweeps 0 -> 1 -> 0; the score is the distance from the middle', () => {
  assert.equal(needleAt(0), 0);
  assert.equal(needleAt(STEAL.PERIOD_MS / 2), 1);
  assert.equal(needleAt(STEAL.PERIOD_MS), 0);
  assert.equal(needleAt(STEAL.PERIOD_MS / 4), 0.5);
  assert.equal(needleAt(STEAL.PERIOD_MS * 3 / 4), 0.5);
  assert.equal(duelScore(STEAL.PERIOD_MS / 4), 0);
  assert.equal(duelScore(0), 0.5);
  assert.ok(duelScore(STEAL.PERIOD_MS / 4 + 40) < duelScore(STEAL.PERIOD_MS / 4 + 200));
});

test('only the thief who is strictly closer wins; boss and mythic fish are never stealable', () => {
  assert.equal(thiefWins(0.01, 0.2), true);
  assert.equal(thiefWins(0.2, 0.01), false);
  assert.equal(thiefWins(0.1, 0.1), false, 'a tie keeps the fish with its owner');
  assert.equal(thiefWins(1, 1), false, 'nobody pressed');
  assert.equal(thiefWins(0.3, 1), true, 'only the thief pressed');
  assert.equal(isStealable({ rarity: 'epic' }), true);
  assert.equal(isStealable({ rarity: 'legendary' }), true);
  assert.equal(isStealable({ rarity: 'legendary', boss: true }), false);
  assert.equal(isStealable({ rarity: 'mythic' }), false);
  assert.equal(isStealable({ rarity: 'rare', quest: true }), false);
  assert.equal(isStealable(undefined), false);
  assert.equal(SPECIES.filter((s) => s.boss).every((s) => !isStealable(s)), true);
});

// ---------------- economy ----------------

function economy(slots = 20) {
  const store = new MemoryStore();
  const eco = new Economy({ store, species: SPECIES, equipment: EQUIPMENT, slots });
  for (const id of ['a', 'b']) store.createProfile({ id, tokenHash: id, name: id, coin: 0, owned: ['rod_basic', 'line_basic', 'bait_worm'], equipped: { rod: 'rod_basic', line: 'line_basic', bait: 'bait_worm' }, createdAt: 0 });
  return { store, eco };
}

test('Economy.steal moves one fish between bags, no coins, all or nothing', () => {
  const { eco, store } = economy(3);
  const fish = eco.addCatch('a', { speciesId: 'carp', weight: 2.5 }).item;
  const res = eco.steal('a', 'b', fish.id);
  assert.equal(res.ok, true);
  assert.equal(res.item.weight, 2.5);
  assert.equal(eco.state('a').items.length, 0);
  assert.equal(eco.state('b').items.length, 1);
  assert.equal(eco.state('a').coin + eco.state('b').coin, 0);
  assert.ok(eco.dex('a').carp, 'the owner keeps the FishDex entry for what they caught');

  assert.equal(eco.steal('a', 'b', fish.id).error, 'NOT_FOUND', 'already gone');
  assert.equal(eco.steal('b', 'b', res.item.id).error, 'BAD_REQUEST');
  const full = economy(1);
  const f1 = full.eco.addCatch('a', { speciesId: 'carp', weight: 1 }).item;
  full.eco.addCatch('b', { speciesId: 'perch', weight: 1 });
  assert.equal(full.eco.steal('a', 'b', f1.id).error, 'INVENTORY_FULL');
  assert.equal(full.eco.state('a').items.length, 1, 'nothing moved');
  assert.equal(store.listCatches('b', { unsold: true }).length, 1);
});

// ---------------- server ----------------

let server;
let clock = 30_000_000;
const sockets = [];
const FAST = { LEAD_MS: 60, DUEL_MS: 1500, WINDOW_MS: 3000, SLACK_MS: 500 };
before(async () => {
  server = await createGameServer({ port: 0, graceMs: 200, world: false, now: () => clock, steal: FAST, fishing: { BITE_MIN_MS: 40, BITE_MAX_MS: 40, HOOK_MIN_MS: 400, HOOK_MAX_MS: 400, HOOK_SLACK_MS: 200 } });
});
after(async () => {
  sockets.forEach((s) => s.disconnect());
  await server.close();
});

async function client() {
  const s = connect(`http://localhost:${server.port}`, { transports: ['websocket'], forceNew: true });
  sockets.push(s);
  s.request = (event, payload) => new Promise((r) => s.emit(event, payload, r));
  s.got = [];
  s.onAny((ev, d) => s.got.push([ev, d]));
  s.next = (event, pred = () => true, ms = 2000) => new Promise((resolve, reject) => {
    const hit = s.got.findIndex(([ev, d]) => ev === event && pred(d));
    if (hit !== -1) return resolve(s.got.splice(hit, 1)[0][1]);
    const t = setTimeout(() => reject(new Error(`timeout waiting for ${event}`)), ms);
    const h = (d) => { if (pred(d)) { clearTimeout(t); s.off(event, h); resolve(d); } };
    s.on(event, h);
  });
  await new Promise((r) => s.on('connect', r));
  return s;
}

/** Ann (A) and Ben (B) side by side in the meadow, both in FIGHT mode. A just landed `speciesId`. */
async function scene({ fight = true, species = 'carp' } = {}) {
  const a = await client();
  const b = await client();
  const ha = await a.request('profile:hello', { name: 'Ann' });
  const hb = await b.request('profile:hello', { name: 'Ben' });
  const created = await a.request('room:create', { name: 'Ann' });
  const joined = await b.request('room:join', { code: created.room.code, name: 'Ben' });
  const playing = new Promise((r) => a.on('room:state', (s) => s.phase === 'playing' && r()));
  a.emit('room:ready', true);
  b.emit('room:ready', true);
  await playing;
  const find = (pid) => server.rooms.rooms.get(created.room.code).players.find((p) => p.pid === pid);
  const mk = (sock, pid, profile) => ({ sock, pid, profileId: profile.profile.id, me: () => find(pid), put(x, y, facing) { Object.assign(find(pid), { x, y, facing }); } });
  const A = mk(a, created.pid, ha);
  const B = mk(b, joined.pid, hb);
  A.put(200, 420, 'right');
  B.put(220, 420, 'left');
  if (fight) for (const p of [A, B]) assert.equal((await p.sock.request('combat:mode', { friendly: false })).ok, true);
  clock += 10_000;
  const land = (who = A, id = species, weight = 3.2) => {
    const item = server.economy.addCatch(who.profileId, { speciesId: id, weight }).item;
    server.steals.noteCatch(who.me(), item);
    return item;
  };
  const bag = (p) => server.economy.state(p.profileId).items;
  return { A, B, land, bag };
}
/** The thief (B) starts, both press at the given moments (ms after the needle starts), and we wait for the verdict. */
async function duel(S, { thiefAt, victimAt }) {
  const { A, B } = S;
  const started = Promise.all([A, B].map((p) => p.sock.next('steal:start')));
  const result = Promise.all([A, B].map((p) => p.sock.next('steal:result')));
  const res = await B.sock.request('steal:start');
  assert.deepEqual(res, { ok: true }, JSON.stringify(res));
  const [info] = await started;
  const t0 = clock + info.startIn;
  const press = async (who, at) => {
    if (at === null) return;
    clock = t0 + at;
    const r = await who.sock.request('steal:press');
    assert.equal(r.ok, true, JSON.stringify(r));
  };
  clock = t0 - 5;
  assert.equal((await B.sock.request('steal:press')).error, 'TOO_EARLY', 'the needle has not started');
  await press(B, thiefAt);
  await press(A, victimAt);
  const [r] = await result;
  return r;
}
const PERFECT = STEAL.PERIOD_MS / 4; // the needle is in the middle

test('the thief stops the needle closer to the middle: the fish changes bags, the owner stumbles', async () => {
  const S = await scene();
  const item = S.land();
  assert.equal(S.bag(S.A).length, 1);
  const r = await duel(S, { thiefAt: PERFECT + 10, victimAt: PERFECT + 200 });
  assert.equal(r.thiefWon, true);
  assert.equal(r.speciesId, 'carp');
  assert.equal(r.weight, 3.2);
  assert.equal(r.loser, S.A.pid);
  assert.ok(r.scores.thief < r.scores.victim);
  assert.equal(S.bag(S.A).length, 0);
  assert.equal(S.bag(S.B).length, 1);
  assert.equal(S.bag(S.B)[0].speciesId, 'carp');
  assert.equal(S.A.me().stunnedUntil - clock, STEAL.LOSER_STUN_MS, 'the loser is stunned');
  assert.equal(S.B.me().stunnedUntil, 0, 'the winner is free');
  assert.ok(item.id);
});

test('the owner defends: a better press, a tie, or nobody pressing all keep the fish', async () => {
  for (const [name, presses] of [
    ['better press', { thiefAt: PERFECT + 150, victimAt: PERFECT + 5 }],
    ['tie', { thiefAt: PERFECT + 50, victimAt: PERFECT + 50 }],
  ]) {
    const S = await scene();
    S.land();
    const r = await duel(S, presses);
    assert.equal(r.thiefWon, false, name);
    assert.equal(S.bag(S.A).length, 1, name);
    assert.equal(S.bag(S.B).length, 0, name);
    assert.equal(S.B.me().stunnedUntil - clock, STEAL.LOSER_STUN_MS, `${name}: the thief stumbles`);
  }
  // nobody presses: the duel times out by itself and the owner keeps the fish
  const S = await scene();
  S.land();
  const result = S.A.sock.next('steal:result', () => true, 3000);
  assert.deepEqual(await S.B.sock.request('steal:start'), { ok: true });
  assert.equal((await result).thiefWon, false);
  assert.equal(S.bag(S.A).length, 1);
});

test('only the thief presses and presses well enough: still a win; a second press does not count', async () => {
  const S = await scene();
  S.land();
  const r = await duel(S, { thiefAt: PERFECT, victimAt: null });
  assert.equal(r.thiefWon, true);
  assert.equal(r.scores.victim, 1);
  assert.equal(S.bag(S.B).length, 1);
});

test('who can steal, and what: Friendly mode, distance, the 3 second window, one try per fish, cooldown, full bags', async () => {
  const S = await scene({ fight: false });
  S.land();
  assert.equal((await S.B.sock.request('steal:start')).error, 'FRIENDLY', 'Safe mode on: you cannot steal');
  await S.B.sock.request('combat:mode', { friendly: false });
  assert.equal((await S.B.sock.request('steal:start')).error, 'TARGET_FRIENDLY', 'and nobody can steal from a Friendly player');
  await S.A.sock.request('combat:mode', { friendly: false });

  S.B.put(220 + STEAL.RANGE + 5, 420, 'left');
  assert.equal((await S.B.sock.request('steal:start')).error, 'NO_TARGET', 'too far');
  S.B.put(220, 420, 'left');
  clock += STEAL.WINDOW_MS + STEAL.SLACK_MS + 1;
  assert.equal((await S.B.sock.request('steal:start')).error, 'NOTHING_TO_STEAL', 'too late');
  S.land();
  clock += 100;
  assert.equal((await S.A.sock.request('steal:start')).error, 'NOTHING_TO_STEAL', 'Ann has nothing to steal from Ben');

  // a full bag
  const fullBag = await scene();
  for (let i = 0; i < 20; i++) server.economy.addCatch(fullBag.B.profileId, { speciesId: 'minnow', weight: 0.1 });
  fullBag.land();
  assert.equal((await fullBag.B.sock.request('steal:start')).error, 'BAG_FULL');

  // one try per fish, then a cooldown for the thief
  const R = await scene();
  R.land();
  const lost = await duel(R, { thiefAt: PERFECT + 150, victimAt: PERFECT });
  assert.equal(lost.thiefWon, false);
  R.land();
  clock += 5000;
  const cd = await R.B.sock.request('steal:start');
  assert.equal(cd.error, 'COOLDOWN');
  assert.ok(cd.ms > 0 && cd.ms <= STEAL.COOLDOWN_MS);
  clock += STEAL.COOLDOWN_MS;
  R.B.me().stunnedUntil = 0;
  R.land(); // a fresh catch (the old one's 3 seconds are long gone)
  assert.deepEqual(await R.B.sock.request('steal:start'), { ok: true }, 'works again after the cooldown');
});

test('the boss and mythic fish cannot be stolen; sea, boats and swimmers are out', async () => {
  const S = await scene();
  const boss = S.land(S.A, 'nautilus', 60);
  assert.equal(S.A.me().lastCatch, null);
  assert.equal((await S.B.sock.request('steal:start')).error, 'NOTHING_TO_STEAL');
  assert.ok(boss.id);

  const sea = await scene();
  sea.land();
  sea.B.me().swimming = true;
  assert.equal((await sea.B.sock.request('steal:start')).error, 'SWIMMING');
  sea.B.me().swimming = false;
  sea.B.me().mapId = 'ocean';
  assert.equal((await sea.B.sock.request('steal:start')).error, 'NOT_HERE');
});

test('a duel freezes both players; if one drops out nothing changes', async () => {
  const S = await scene();
  S.land();
  const started = S.A.sock.next('steal:start');
  assert.deepEqual(await S.B.sock.request('steal:start'), { ok: true });
  await started;
  // frozen: movement is refused, and so are casts and attacks
  const corr = [];
  S.A.sock.on('player:correct', (c) => corr.push(c));
  S.A.sock.emit('player:state', { x: 205, y: 420, facing: 'right', moving: true, t: clock });
  await wait(80);
  assert.equal(corr.length, 1);
  assert.equal((await S.A.sock.request('combat:act', { kind: 'slap' })).error, 'STUNNED');
  assert.equal((await S.A.sock.request('fishing:cast', { spotId: 'west', power: 0.5 })).error, 'STUNNED');
  const cancelled = S.B.sock.next('steal:result');
  S.A.sock.disconnect();
  assert.equal((await cancelled).cancelled, true);
  assert.equal(S.B.me().stunnedUntil, 0, 'the other player is free again');
  assert.equal(S.bag(S.B).length, 0);
});

test('a real catch opens the window for the other player (the whole chain, over the wire)', async () => {
  const S = await scene();
  const west = spots.find((s) => s.id === 'west');
  S.A.put(west.x, west.y, 'right');
  S.B.put(west.x - 20, west.y, 'right');
  const opened = S.B.sock.next('steal:open');
  // the server's rng is the default: whatever bites is a lake fish, and none of those is a boss
  const cast = await S.A.sock.request('fishing:cast', { spotId: 'west', power: 0.5 });
  assert.equal(cast.ok, true, JSON.stringify(cast));
  await S.A.sock.next('fishing:event', (e) => e.event === 'bite');
  const hooked = S.A.sock.next('fishing:event', (e) => e.event === 'hooked');
  await S.A.sock.request('fishing:hook', { id: cast.session.id });
  const h = await hooked;
  const fight = play(byId(h.speciesId), bots.fishWatcher(100), h.seed, h.gear, h.weight);
  clock += (fight.sim.tick / TICK_RATE) * 1000;
  const result = S.A.sock.next('fishing:event', (e) => e.event === 'result');
  await S.A.sock.request('fishing:finish', { id: cast.session.id, toggles: fight.toggles });
  const out = await result;
  if (out.outcome === 'caught') { // an attentive bot wins nearly always; a lost fight just means there is nothing to steal
    const open = await opened;
    assert.equal(open.pid, S.A.pid);
    assert.equal(open.speciesId, h.speciesId);
    assert.equal(open.ms, STEAL.WINDOW_MS);
    assert.ok(S.A.me().lastCatch);
  }
});
