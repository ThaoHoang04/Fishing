import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { io as connect } from 'socket.io-client';
import { createGameServer } from '../server/index.js';
import { MOVES, ANGER_MAX, ANGER_STOLEN, THROW } from '../src/systems/Combat.js';
import { WATER_RECT } from '../src/data/world.js';

const readJson = (rel) => JSON.parse(readFileSync(new URL(rel, import.meta.url), 'utf8'));
const DUEL = readJson('../src/data/duel.json');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------- data ----------------

test('combat data: the angry meter rewards a big shove, anything thrown is light, nothing is lethal', () => {
  assert.ok(MOVES.big.needsAnger && MOVES.big.knock > MOVES.push.knock && MOVES.big.stunMs <= 1500, 'bigger than a push, but still only a shove');
  assert.equal(MOVES.big.cooldownMs, 0, 'the meter is the limit, not a timer');
  assert.ok(MOVES.throw.knock <= 12 && MOVES.throw.stunMs <= 500, 'a thrown fish is a nuisance');
  for (const [name, m] of Object.entries(MOVES)) assert.ok(m.anger >= 0 && m.stunMs <= 1500, name);
  assert.ok(ANGER_MAX === 100 && ANGER_STOLEN > 0 && ANGER_STOLEN < ANGER_MAX, 'one robbery is not enough for a big shove');
  // three ordinary hits are not enough either, five or so are
  assert.ok(MOVES.bonk.anger * 3 < ANGER_MAX && MOVES.bonk.anger * 6 >= ANGER_MAX);
  assert.ok(THROW.speed > 0 && THROW.ttlMs > 0 && THROW.radius > 0);
});

test('duel data: health, countdown and moves with sane damage; a prize you cannot farm', () => {
  assert.ok(DUEL.hp >= 50 && DUEL.countdownMs >= 2000 && DUEL.durationMs >= 30000);
  assert.ok(DUEL.reward.dailyLimit >= 1 && DUEL.reward.dailyLimit <= 5 && DUEL.reward.coins > 0 && DUEL.reward.coins <= 200);
  const { punch, kick, push, dodge } = DUEL.moves;
  assert.ok(kick.dmg > punch.dmg && kick.cooldownMs > punch.cooldownMs, 'the kick hits harder and slower');
  assert.ok(push.knock > kick.knock && push.dmg < punch.dmg, 'a shove is for distance, not damage');
  assert.ok(dodge.dodgeMs > 200 && dodge.cooldownMs > dodge.dodgeMs, 'a dodge does not make you permanently untouchable');
  for (const m of [punch, kick, push]) assert.ok(m.dmg * 5 < DUEL.hp * 3 && m.range <= 40);
});

// ---------------- the server ----------------

let server;
let clock = 60_000_000;
const sockets = [];
before(async () => {
  server = await createGameServer({
    port: 0, graceMs: 200, world: false, now: () => clock,
    duel: { countdownMs: 40, durationMs: 400, acceptMs: 300, offerCooldownMs: 100, hp: 100, ring: null },
  });
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
  s.next = (event, pred = () => true, ms = 2500) => new Promise((resolve, reject) => {
    const hit = s.got.findIndex(([ev, d]) => ev === event && pred(d));
    if (hit !== -1) return resolve(s.got.splice(hit, 1)[0][1]);
    const t = setTimeout(() => reject(new Error(`timeout waiting for ${event}`)), ms);
    const h = (d) => { if (pred(d)) { clearTimeout(t); s.off(event, h); resolve(d); } };
    s.on(event, h);
  });
  await new Promise((r) => s.on('connect', r));
  return s;
}

async function pair({ fight = true } = {}) {
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
  if (fight) for (const p of [A, B]) await p.sock.request('combat:mode', { friendly: false });
  clock += 20_000;
  return { A, B, room: server.rooms.rooms.get(created.room.code) };
}

// ---- angry meter ----

test('being hit fills the angry meter; at full, the BIG PUSH is yours once, hits far and empties the meter', async () => {
  const { A, B } = await pair();
  assert.equal(B.me().anger, 0);
  assert.equal((await B.sock.request('combat:act', { kind: 'big' })).error, 'NOT_ANGRY');
  await A.sock.request('combat:act', { kind: 'bonk' });
  assert.equal(B.me().anger, MOVES.bonk.anger);
  const seen = B.sock.next('room:state', (st) => st.players.find((p) => p.pid === B.pid).anger === MOVES.bonk.anger + 1);
  server.rooms.addAnger(B.me(), 1);
  const view = await seen;
  assert.equal(view.players.find((p) => p.pid === B.pid).anger, MOVES.bonk.anger + 1, 'the meter is public in the room state');
  assert.equal(A.me().anger, 0, 'the one who hits gets no angrier');

  server.rooms.addAnger(B.me(), 500);
  assert.equal(B.me().anger, ANGER_MAX, 'capped');
  clock += 10_000;
  B.me().stunnedUntil = 0;
  A.put(200, 420, 'right');
  B.put(220, 420, 'left');
  const hit = await new Promise((r) => { A.sock.once('combat:hit', r); B.sock.request('combat:act', { kind: 'big' }); });
  // B shoves A: A flies from x=200 leftwards, far more than a push
  assert.equal(hit.kind, 'big');
  assert.equal(hit.to, A.pid);
  assert.equal(Math.round(hit.x), 200 - MOVES.big.knock);
  assert.equal(hit.stunMs, MOVES.big.stunMs);
  assert.equal(B.me().anger, 0, 'the meter is spent');
  clock += 10_000;
  assert.equal((await B.sock.request('combat:act', { kind: 'big' })).error, 'NOT_ANGRY', 'one per full meter');
});

test('the big push is spent even if it misses, still needs FIGHT mode, and can drop someone into the lake', async () => {
  const { A, B } = await pair();
  server.rooms.addAnger(A.me(), ANGER_MAX);
  B.put(400, 420, 'left'); // far away
  assert.deepEqual(await A.sock.request('combat:act', { kind: 'big' }), { ok: true, hit: false });
  assert.equal(A.me().anger, 0, 'a swing and a miss uses it up');

  const friendly = await pair({ fight: false });
  server.rooms.addAnger(friendly.A.me(), ANGER_MAX);
  assert.equal((await friendly.A.sock.request('combat:act', { kind: 'big' })).error, 'FRIENDLY', 'anger does not override Friendly mode');
  assert.equal(friendly.A.me().anger, ANGER_MAX);

  const lake = await pair();
  server.rooms.addAnger(lake.A.me(), ANGER_MAX);
  const y = WATER_RECT.y + WATER_RECT.h / 2;
  lake.A.put(WATER_RECT.x - 26, y, 'right');
  lake.B.put(WATER_RECT.x - 8, y, 'left');
  const res = await lake.A.sock.request('combat:act', { kind: 'big' });
  assert.equal(res.hit, true);
  assert.equal(lake.B.me().swimming, true, 'a big push at the shore means a swim');
});

// ---- thrown fish ----

test('throwing: needs something light in the bag, is slow, hits the first player in the way, and the item is kept', async () => {
  const { A, B } = await pair();
  assert.equal((await A.sock.request('combat:throw')).error, 'NO_AMMO', 'an empty bag has nothing to throw');
  server.economy.addCatch(A.profileId, { speciesId: 'boot', weight: 0.8 });
  server.economy.addCatch(A.profileId, { speciesId: 'legendary_placeholder', weight: 9 }); // unknown species: ignored
  const flying = A.sock.next('combat:throw');
  const bSees = B.sock.next('combat:throw');
  assert.deepEqual(await A.sock.request('combat:throw'), { ok: true });
  const shot = await flying;
  assert.deepEqual(await bSees, shot, 'both see it fly');
  assert.equal(shot.speed, THROW.speed);
  assert.equal(shot.facing, 'right');
  assert.equal(typeof shot.icon, 'number');
  assert.equal(server.economy.state(A.profileId).items.length, 1, 'it is a joke: the boot is not lost');
  assert.equal((await A.sock.request('combat:throw')).error, 'COOLDOWN');

  // it travels: 20 px away takes a moment, so B can still be hit if they stay put
  const hit = B.sock.next('combat:hit', (e) => e.kind === 'throw', 3000);
  clock += 400;
  server.rooms.tickProjectiles(clock - 300);
  server.rooms.tickProjectiles(clock - 150);
  server.rooms.tickProjectiles(clock);
  const e = await hit;
  assert.deepEqual([e.from, e.to], [A.pid, B.pid]);
  assert.equal(e.stunMs, MOVES.throw.stunMs);
  assert.ok(B.me().anger >= MOVES.throw.anger);
  assert.ok(B.me().x > 220, 'knocked a little the way it was flying');
});

test('a thrown fish passes through a Friendly player, flies out of range, and cannot be thrown without FIGHT mode', async () => {
  const { A, B } = await pair();
  server.economy.addCatch(A.profileId, { speciesId: 'boot', weight: 0.8 });
  await B.sock.request('combat:mode', { friendly: true });
  assert.deepEqual(await A.sock.request('combat:throw'), { ok: true });
  server.rooms.tickProjectiles(clock + 100);
  server.rooms.tickProjectiles(clock + 300);
  assert.equal(B.me().anger, 0, 'a Friendly player is not hit');
  server.rooms.tickProjectiles(clock + THROW.ttlMs + 500);
  const room = server.rooms.rooms.get([...server.rooms.rooms.keys()].at(-1));
  assert.equal(room.projectiles.length, 0, 'it has landed in the grass');

  const calm = await pair({ fight: false });
  server.economy.addCatch(calm.A.profileId, { speciesId: 'boot', weight: 0.8 });
  assert.equal((await calm.A.sock.request('combat:throw')).error, 'FRIENDLY');
});

// ---- duels ----

test('a duel: challenge, accept, countdown, then moves with health; a dodge dodges; a KO ends it and pays a prize', async () => {
  const { A, B } = await pair({ fight: false }); // duels need no FIGHT mode: accepting is the consent
  const offer = B.sock.next('duel:offer');
  assert.deepEqual(await A.sock.request('duel:challenge'), { ok: true });
  assert.deepEqual(await offer, { from: A.pid, ms: 300 });
  assert.equal((await A.sock.request('duel:challenge')).error, 'OFFER_PENDING');
  assert.equal((await A.sock.request('duel:respond', { accept: true })).error, 'NO_OFFER', 'only the challenged player answers');
  const startA = A.sock.next('duel:start');
  const res = await B.sock.request('duel:respond', { accept: true });
  assert.deepEqual(res, { ok: true, started: true });
  const start = await startA;
  assert.deepEqual([start.hp, start.moves], [100, ['punch', 'kick', 'push', 'dodge']]);
  assert.ok(A.me().stunnedUntil > clock, 'frozen for the countdown');
  assert.equal((await A.sock.request('duel:act', { kind: 'punch' })).error, 'TOO_EARLY');

  clock += 60;
  A.me().stunnedUntil = 0;
  B.me().stunnedUntil = 0;
  A.put(200, 420, 'right');
  B.put(220, 420, 'left');
  const hit = A.sock.next('duel:hit', (e) => e.dmg > 0);
  assert.deepEqual(await A.sock.request('duel:act', { kind: 'punch' }), { ok: true, hit: true });
  const e = await hit;
  assert.deepEqual([e.from, e.to, e.dmg, e.hp[B.pid], e.hp[A.pid]], [A.pid, B.pid, DUEL.moves.punch.dmg, 100 - DUEL.moves.punch.dmg, 100]);
  assert.equal((await A.sock.request('duel:act', { kind: 'punch' })).error, 'COOLDOWN');

  // B dodges: A's next hit finds nobody
  clock += 2000;
  B.me().stunnedUntil = 0;
  A.put(200, 420, 'right');
  B.put(220, 420, 'left');
  await B.sock.request('duel:act', { kind: 'dodge' });
  const dodged = A.sock.next('duel:hit', (x) => x.dodged);
  assert.deepEqual(await A.sock.request('duel:act', { kind: 'kick' }), { ok: true, hit: false, dodged: true });
  assert.equal((await dodged).dmg, 0);

  // knock B out with a stream of kicks (the clock is ours)
  const ended = A.sock.next('duel:end');
  for (let i = 0; i < 20 && server.rooms.rooms.get([...server.rooms.rooms.keys()].at(-1)).duel; i++) {
    clock += 1100;
    B.me().stunnedUntil = 0;
    A.me().stunnedUntil = 0;
    A.put(200, 420, 'right');
    B.put(220, 420, 'left');
    B.me().x = 220;
    await A.sock.request('duel:act', { kind: 'kick' });
  }
  const end = await ended;
  assert.equal(end.reason, 'ko');
  assert.equal(end.winner, A.pid);
  assert.equal(end.coins, DUEL.reward.coins);
  assert.equal(server.economy.state(A.profileId).coin, DUEL.reward.coins);
  assert.equal(server.economy.state(B.profileId).coin, 0, 'the loser loses nothing');
  assert.equal(server.economy.state(B.profileId).items.length, 0);
  assert.ok(B.me().stunnedUntil > 0 && B.me().stunnedUntil <= clock + 1300, 'a moment of stars, then free');
  const stats = server.store.getProfile(A.profileId).meta.stats;
  assert.deepEqual([stats.duelsWon, stats.duels], [1, 1]);
  assert.equal(server.store.getProfile(B.profileId).meta.stats.duelsWon, undefined);
  assert.equal((await A.sock.request('duel:act', { kind: 'punch' })).error, 'NO_DUEL');
});

test('declining or ignoring a challenge ends it; ordinary combat moves are off during a duel; leaving cancels it', async () => {
  const { A, B, room } = await pair();
  const declined = A.sock.next('duel:declined');
  await A.sock.request('duel:challenge');
  assert.deepEqual(await B.sock.request('duel:respond', { accept: false }), { ok: true, started: false });
  assert.equal((await declined).by, B.pid);
  assert.equal(room.duelOffer, null);
  assert.equal((await B.sock.request('duel:respond', { accept: true })).error, 'NO_OFFER');

  await wait(150);
  clock += 1000;
  await A.sock.request('duel:challenge');
  clock += 1000; // the offer expired
  assert.equal((await B.sock.request('duel:respond', { accept: true })).error, 'NO_OFFER');

  clock += 1000;
  await wait(150);
  await A.sock.request('duel:challenge');
  await B.sock.request('duel:respond', { accept: true });
  clock += 60;
  assert.equal((await A.sock.request('combat:act', { kind: 'slap' })).error, 'DUEL', 'the cartoon moves are for outside a duel');
  assert.equal((await A.sock.request('combat:throw')).error ?? 'NO_AMMO', 'NO_AMMO');
  const cancelled = B.sock.next('duel:end');
  server.duels.cancelFor(A.me());
  const end = await cancelled;
  assert.deepEqual([end.reason, end.winner, end.coins], ['cancelled', null, 0]);
  assert.equal(room.duel, null);
  assert.equal(server.economy.state(B.profileId).coin, 0);
});

test('only a few prizes a day: after the limit a win pays nothing, the next day pays again', async () => {
  const { A } = await pair({ fight: false });
  const first = server.social.duelPrize(A.me(), DUEL.reward);
  assert.equal(first, DUEL.reward.coins);
  for (let i = 1; i < DUEL.reward.dailyLimit; i++) assert.equal(server.social.duelPrize(A.me(), DUEL.reward), DUEL.reward.coins);
  assert.equal(server.social.duelPrize(A.me(), DUEL.reward), 0, 'the daily limit is used up');
  assert.equal(server.economy.state(A.profileId).coin, DUEL.reward.coins * DUEL.reward.dailyLimit);
  clock += 24 * 3600 * 1000;
  assert.equal(server.social.duelPrize(A.me(), DUEL.reward), DUEL.reward.coins, 'a new day');
});

test('duels are on foot only: not at sea, not while swimming', async () => {
  const { A, B } = await pair();
  B.me().swimming = true;
  assert.equal((await A.sock.request('duel:challenge')).error, 'BUSY');
  B.me().swimming = false;
  B.me().mapId = 'ocean';
  assert.equal((await A.sock.request('duel:challenge')).error, 'NOT_HERE');
});
