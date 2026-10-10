import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { io as connect } from 'socket.io-client';
import { createGameServer } from '../server/index.js';
import { MOVES, MOVE_GAP_MS, MODE_LOCK_MS, canReach, knockedTo } from '../src/systems/Combat.js';
import { LAKE_MAP, OCEAN_MAP } from '../src/data/maps.js';
import { isBlocked, bodyRect } from '../src/systems/Collision.js';
import { WATER_RECT } from '../src/data/world.js';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------- rules ----------------

test('reach: close, and in front of the way you face', () => {
  const a = { x: 100, y: 100, facing: 'right' };
  assert.equal(canReach(a, { x: 120, y: 100 }, MOVES.slap), true);
  assert.equal(canReach(a, { x: 80, y: 100 }, MOVES.slap), false, 'behind you');
  assert.equal(canReach(a, { x: 100 + MOVES.slap.range + 1, y: 100 }, MOVES.slap), false, 'too far');
  assert.equal(canReach({ ...a, facing: 'up' }, { x: 100, y: 85 }, MOVES.push), true);
  assert.equal(canReach({ ...a, facing: 'down' }, { x: 100, y: 85 }, MOVES.push), false);
  assert.equal(canReach(a, { x: 101, y: 101 }, MOVES.bonk), true, 'standing on each other counts');
});

test('knockback slides until something is in the way, and never into water or a tree', () => {
  const open = knockedTo(LAKE_MAP, { x: 200, y: 400 }, 'right', 30);
  assert.deepEqual(open, { x: 230, y: 400, fell: false });
  // on the shore, knocked towards the lake: stops at the water's edge
  const y = WATER_RECT.y + WATER_RECT.h / 2;
  const shore = knockedTo(LAKE_MAP, { x: WATER_RECT.x - 12, y }, 'right', 60);
  assert.ok(!isBlocked(bodyRect(shore.x, shore.y, LAKE_MAP), LAKE_MAP), 'ends on dry ground');
  assert.ok(shore.x < WATER_RECT.x + 2, 'did not go into the water');
  const edge = knockedTo(LAKE_MAP, { x: 4, y: 400 }, 'left', 30);
  assert.ok(edge.x >= 0, 'not off the map');
  for (const m of Object.values(MOVES)) assert.ok(m.stunMs <= 1500 && m.range <= 40, 'cartoon scale: short stuns, short reach');
});

// ---------------- server ----------------

let server;
let clock = 9_000_000;
const sockets = [];
before(async () => {
  server = await createGameServer({ port: 0, graceMs: 200, world: false, now: () => clock });
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
  await new Promise((r) => s.on('connect', r));
  return s;
}

async function duo() {
  const a = await client();
  const b = await client();
  await a.request('profile:hello', { name: 'Ann' });
  await b.request('profile:hello', { name: 'Ben' });
  const created = await a.request('room:create', { name: 'Ann' });
  const joined = await b.request('room:join', { code: created.room.code, name: 'Ben' });
  const playing = new Promise((r) => a.on('room:state', (s) => s.phase === 'playing' && r()));
  a.emit('room:ready', true);
  b.emit('room:ready', true);
  await playing;
  const find = (pid) => server.rooms.rooms.get(created.room.code).players.find((p) => p.pid === pid);
  const mk = (sock, pid) => ({ sock, pid, me: () => find(pid), put(x, y, facing) { Object.assign(find(pid), { x, y, facing }); } });
  const A = mk(a, created.pid);
  const B = mk(b, joined.pid);
  // face off in the middle of the meadow, A looking at B
  A.put(200, 400, 'right');
  B.put(220, 400, 'left');
  clock += 10_000;
  return { A, B };
}
const fightMode = async (...ps) => { for (const p of ps) assert.deepEqual(await p.sock.request('combat:mode', { friendly: false }), { ok: true, friendly: false }); };

test('everyone starts in Friendly mode: nobody can hit anybody', async () => {
  const { A, B } = await duo();
  assert.equal(A.me().friendly, true);
  assert.equal((await A.sock.request('combat:act', { kind: 'slap' })).error, 'FRIENDLY');
  assert.deepEqual([B.me().x, B.me().y], [220, 400]);
});

test('both must opt in: a Friendly target cannot be hit, and nothing happens (no cooldown used)', async () => {
  const { A, B } = await duo();
  await fightMode(A);
  assert.equal(B.me().friendly, true);
  assert.equal((await A.sock.request('combat:act', { kind: 'slap' })).error, 'TARGET_FRIENDLY');
  assert.deepEqual([B.me().x, B.me().y], [220, 400]);
  await fightMode(B);
  const r = await A.sock.request('combat:act', { kind: 'slap' });
  assert.deepEqual(r, { ok: true, hit: true }, 'works at once: the refused attempt cost nothing');
});

test('a slap knocks the target back and stuns them: they cannot move, their moves are corrected', async () => {
  const { A, B } = await duo();
  await fightMode(A, B);
  const hitA = new Promise((r) => A.sock.once('combat:hit', r));
  const hitB = new Promise((r) => B.sock.once('combat:hit', r));
  const corrected = new Promise((r) => B.sock.once('player:correct', r));
  assert.deepEqual(await A.sock.request('combat:act', { kind: 'slap' }), { ok: true, hit: true });
  const e = await hitA;
  assert.deepEqual(e, await hitB, 'both see the same event');
  assert.deepEqual(e, { kind: 'slap', from: A.pid, to: B.pid, x: 220 + MOVES.slap.knock, y: 400, stunMs: MOVES.slap.stunMs, fell: false });
  assert.deepEqual([B.me().x, B.me().y], [e.x, e.y]);
  assert.deepEqual(await corrected, { x: e.x, y: e.y }, 'the victim\'s screen is moved too');

  // dizzy: movement refused until the stun is over
  const bad = [];
  B.sock.on('player:correct', (c) => bad.push(c));
  B.sock.emit('player:state', { x: 230, y: 400, facing: 'left', moving: true, t: clock });
  await wait(80);
  assert.equal(bad.length, 1);
  assert.equal(B.me().x, e.x);
  clock += MOVES.slap.stunMs;
  B.sock.emit('player:state', { x: e.x - 2, y: 400, facing: 'left', moving: true, t: clock });
  await wait(80);
  assert.equal(B.me().x, e.x - 2, 'free again');
  assert.equal(bad.length, 1);
});

test('push knocks further, bonk stuns longer; each has its own cooldown and there is a short gap between moves', async () => {
  const { A, B } = await duo();
  await fightMode(A, B);
  const push = await A.sock.request('combat:act', { kind: 'push' });
  assert.equal(push.hit, true);
  assert.equal(B.me().x, 220 + MOVES.push.knock);
  assert.equal((await A.sock.request('combat:act', { kind: 'bonk' })).error, 'COOLDOWN', 'too soon after any move');
  clock += MOVE_GAP_MS;
  A.put(200, 400, 'right');
  B.put(215, 400, 'left');
  const bonk = await A.sock.request('combat:act', { kind: 'bonk' });
  assert.equal(bonk.hit, true);
  assert.equal(B.me().stunnedUntil - clock, MOVES.bonk.stunMs);
  clock += MOVE_GAP_MS + 1;
  assert.equal((await A.sock.request('combat:act', { kind: 'push' })).error, 'COOLDOWN', 'push is still cooling down');
  clock += MOVES.push.cooldownMs;
  assert.equal((await A.sock.request('combat:act', { kind: 'nope' })).error, 'BAD_MOVE');
});

test('a miss costs the cooldown; out of reach or behind you is a miss', async () => {
  const { A, B } = await duo();
  await fightMode(A, B);
  B.put(300, 400, 'left'); // far away
  assert.deepEqual(await A.sock.request('combat:act', { kind: 'slap' }), { ok: true, hit: false });
  clock += MOVE_GAP_MS;
  assert.equal((await A.sock.request('combat:act', { kind: 'slap' })).error, 'COOLDOWN');
  clock += MOVES.slap.cooldownMs;
  B.put(180, 400, 'right'); // behind A
  assert.deepEqual(await A.sock.request('combat:act', { kind: 'slap' }), { ok: true, hit: false });
  assert.equal(B.me().x, 180);
});

test('a stunned player cannot attack back', async () => {
  const { A, B } = await duo();
  await fightMode(A, B);
  await A.sock.request('combat:act', { kind: 'bonk' });
  assert.equal((await B.sock.request('combat:act', { kind: 'slap' })).error, 'STUNNED');
  clock += MOVES.bonk.stunMs;
  A.put(200, 400, 'right');
  B.put(215, 400, 'right'); // facing away from A
  assert.equal((await B.sock.request('combat:act', { kind: 'slap' })).hit, false, 'free to act again (A is behind B: a miss)');
});

test('Friendly mode cannot be switched back on in the middle of a brawl, only afterwards', async () => {
  const { A, B } = await duo();
  await fightMode(A, B);
  await A.sock.request('combat:act', { kind: 'slap' });
  assert.deepEqual(await B.sock.request('combat:mode', { friendly: true }), { ok: false, error: 'IN_FIGHT' });
  clock += MODE_LOCK_MS;
  assert.deepEqual(await B.sock.request('combat:mode', { friendly: true }), { ok: true, friendly: true });
  assert.equal(B.me().friendly, true);
  assert.equal((await A.sock.request('combat:mode', { friendly: 'yes' })).error, 'BAD_REQUEST');
  clock += 5000;
  B.put(220, 400, 'left');
  assert.equal((await A.sock.request('combat:act', { kind: 'slap' })).error, 'TARGET_FRIENDLY');
});

test('fighting is on foot only: not at sea, not on a shared boat; the mode is public in the room view', async () => {
  const { A, B } = await duo();
  await fightMode(A, B);
  const view = new Promise((r) => A.sock.on('room:state', (s) => r(s)));
  await B.sock.request('combat:mode', { friendly: true });
  const room = await view;
  assert.equal(room.players.find((p) => p.pid === B.pid).friendly, true);
  await B.sock.request('combat:mode', { friendly: false });

  for (const p of [A, B]) {
    p.me().x = 324; p.me().y = 180;
    assert.equal((await p.sock.request('map:travel', { portalId: 'lake_boat' })).ok, true);
  }
  A.put(300, 400, 'right');
  B.put(310, 400, 'left');
  clock += 5000;
  assert.equal((await A.sock.request('combat:act', { kind: 'push' })).error, 'NOT_HERE', 'no fighting at sea');
  assert.equal(OCEAN_MAP.movement, 'boat');
});

test('the fight is private to the map: a player on another map sees nothing', async () => {
  const { A, B } = await duo();
  await fightMode(A, B);
  const third = [];
  B.me().x = 324; B.me().y = 180;
  await B.sock.request('map:travel', { portalId: 'lake_boat' });
  B.sock.on('combat:hit', (e) => third.push(e));
  await A.sock.request('combat:act', { kind: 'slap' });
  await wait(100);
  assert.equal(third.length, 0);
});
