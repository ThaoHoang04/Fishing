import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { io as connect } from 'socket.io-client';
import { createGameServer } from '../server/index.js';
import { RESCUE_RANGE, RESCUE_OFFER_MS } from '../server/rooms.js';
import { LAKE_MAP } from '../src/data/maps.js';
import { WATER_RECT } from '../src/data/world.js';
import { knockedTo, dryNear, MOVES } from '../src/systems/Combat.js';
import { isBlocked, bodyRect, moveFeet, isWaterAt } from '../src/systems/Collision.js';
import { SWIM_SPEED, PLAYER_SPEED } from '../src/config.js';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const midY = WATER_RECT.y + WATER_RECT.h / 2;
const dry = (p) => !isBlocked(bodyRect(p.x, p.y, LAKE_MAP), LAKE_MAP);

// ---------------- rules ----------------

test('a push that meets water drops the victim in; a slap or a tree does not', () => {
  const edge = { x: WATER_RECT.x - 5, y: midY };
  const pushed = knockedTo(LAKE_MAP, edge, 'right', MOVES.push.knock, true);
  assert.equal(pushed.fell, true);
  assert.ok(pushed.x > WATER_RECT.x, 'in the water');
  assert.ok(isWaterAt(pushed.x, pushed.y, LAKE_MAP));
  assert.equal(knockedTo(LAKE_MAP, edge, 'right', MOVES.slap.knock, false).fell, false, 'without fall the shore stops you');
  assert.equal(knockedTo(LAKE_MAP, { x: 10, y: 400 }, 'left', 60, true).fell, false, 'the map edge is not water');
  // away from the water: a plain knockback
  assert.deepEqual(knockedTo(LAKE_MAP, { x: 200, y: 420 }, 'right', 30, true), { x: 230, y: 420, fell: false });
  // from the pier into the lake: the pier edge is "water" too
  const pier = knockedTo(LAKE_MAP, { x: 326, y: 150 }, 'right', 30, true);
  assert.equal(pier.fell, true);
});

test('swimmers cross water that blocks walkers, but not trees; the nearest dry spot is always standable', () => {
  const inWater = { x: WATER_RECT.x + 40, y: midY };
  assert.equal(isBlocked(bodyRect(inWater.x, inWater.y, LAKE_MAP), LAKE_MAP), true);
  assert.equal(isBlocked(bodyRect(inWater.x, inWater.y, LAKE_MAP), LAKE_MAP, true), false);
  assert.deepEqual(moveFeet(inWater.x, inWater.y, -2, 0, LAKE_MAP), { x: inWater.x, y: inWater.y }, 'walking cannot enter...');
  assert.deepEqual(moveFeet(inWater.x, inWater.y, -2, 0, LAKE_MAP, true), { x: inWater.x - 2, y: inWater.y }, '...swimming can');
  assert.ok(SWIM_SPEED < PLAYER_SPEED);
  for (const [x, y] of [[WATER_RECT.x + 40, midY], [WATER_RECT.x + WATER_RECT.w / 2, midY], [WATER_RECT.x + WATER_RECT.w - 30, WATER_RECT.y + 20], [150, WATER_RECT.y + 40]]) {
    const spot = dryNear(LAKE_MAP, x, y);
    assert.ok(spot && dry(spot), `dry ground near ${x},${y}`);
  }
  const tree = LAKE_MAP.solids[0];
  assert.equal(isBlocked(bodyRect(tree.x + 2, tree.y + 2, LAKE_MAP), LAKE_MAP, true), true, 'a swimmer cannot pass through a solid');
});

// ---------------- server ----------------

let server;
let clock = 20_000_000;
const sockets = [];
before(async () => {
  server = await createGameServer({ port: 0, graceMs: 200, swimMs: 5000, world: false, now: () => clock });
});
after(async () => {
  sockets.forEach((s) => s.disconnect());
  await server.close();
});

async function client(srv = server) {
  const s = connect(`http://localhost:${srv.port}`, { transports: ['websocket'], forceNew: true });
  sockets.push(s);
  s.request = (event, payload) => new Promise((r) => s.emit(event, payload, r));
  s.got = [];
  s.onAny((ev, d) => s.got.push([ev, d]));
  await new Promise((r) => s.on('connect', r));
  return s;
}

/** Two fighters on the west shore: Ann (A) on the grass facing Ben (B), who is a step from the water. */
async function shore(srv = server, tick = () => {}) {
  const a = await client(srv);
  const b = await client(srv);
  await a.request('profile:hello', { name: 'Ann' });
  await b.request('profile:hello', { name: 'Ben' });
  const created = await a.request('room:create', { name: 'Ann' });
  const joined = await b.request('room:join', { code: created.room.code, name: 'Ben' });
  const playing = new Promise((r) => a.on('room:state', (s) => s.phase === 'playing' && r()));
  a.emit('room:ready', true);
  b.emit('room:ready', true);
  await playing;
  const find = (pid) => srv.rooms.rooms.get(created.room.code).players.find((p) => p.pid === pid);
  const mk = (sock, pid) => ({ sock, pid, me: () => find(pid), put(x, y, facing) { Object.assign(find(pid), { x, y, facing }); } });
  const A = mk(a, created.pid);
  const B = mk(b, joined.pid);
  tick();
  for (const p of [A, B]) assert.equal((await p.sock.request('combat:mode', { friendly: false })).ok, true);
  A.put(WATER_RECT.x - 22, midY, 'right');
  B.put(WATER_RECT.x - 5, midY, 'left');
  return { A, B };
}
/** B ends up swimming. */
async function dunk(A, B) {
  const corrected = new Promise((r) => B.sock.once('player:correct', r));
  const res = await A.sock.request('combat:act', { kind: 'push' });
  assert.deepEqual(res, { ok: true, hit: true });
  await corrected;
}

test('pushed off the shore: they fall in, are public as swimming, and the event says so', async () => {
  clock += 10_000;
  const { A, B } = await shore();
  const hit = new Promise((r) => A.sock.once('combat:hit', r));
  const view = new Promise((r) => A.sock.on('room:state', (s) => s.players.find((p) => p.pid === B.pid).swimming && r(s)));
  await dunk(A, B);
  const e = await hit;
  assert.equal(e.fell, true);
  assert.equal(B.me().swimming, true);
  assert.ok(isWaterAt(B.me().x, B.me().y, LAKE_MAP), 'in the lake');
  assert.equal((await view).players.find((p) => p.pid === B.pid).swimming, true);
  assert.equal(A.me().swimming, false);
});

test('a swimmer paddles slowly, cannot fish, fight, sail or be hit, and is back to normal on dry land', async () => {
  clock += 10_000;
  const { A, B } = await shore();
  await dunk(A, B);
  clock += MOVES.push.stunMs; // the dizzy part is over
  const x0 = B.me().x;
  // a normal walking step in the water is fine for a swimmer, a sprint is not
  B.sock.emit('player:state', { x: x0 + 1, y: midY, facing: 'right', moving: true, t: clock });
  await wait(80);
  assert.equal(B.me().x, x0 + 1);
  clock += 1000;
  const bad = [];
  B.sock.on('player:correct', (c) => bad.push(c));
  B.sock.emit('player:state', { x: x0 + 1 + SWIM_SPEED * 3, y: midY, facing: 'right', moving: true, t: clock });
  await wait(80);
  assert.equal(bad.length, 1, 'faster than swimming speed is refused');

  assert.equal((await B.sock.request('fishing:cast', { spotId: 'west', power: 0.5 })).error, 'SWIMMING');
  assert.equal((await B.sock.request('combat:act', { kind: 'slap' })).error, 'SWIMMING');
  assert.equal((await B.sock.request('map:travel', { portalId: 'lake_boat' })).error, 'SWIMMING');
  assert.equal((await B.sock.request('boat:board')).error, 'SWIMMING');
  // nobody can punch a swimmer
  A.put(WATER_RECT.x - 22, midY, 'right');
  B.me().x = WATER_RECT.x - 5 + 12;
  clock += 5000;
  assert.deepEqual(await A.sock.request('combat:act', { kind: 'slap' }), { ok: true, hit: false });

  // paddle back to the shore under its own power: swimming ends when the hitbox is on dry land
  B.me().x = WATER_RECT.x + 3;
  B.me().y = midY;
  clock += 2000;
  const ended = new Promise((r) => A.sock.on('room:state', (s) => !s.players.find((p) => p.pid === B.pid).swimming && r(s)));
  B.sock.emit('player:state', { x: WATER_RECT.x - 6, y: midY, facing: 'left', moving: true, t: clock });
  await ended;
  assert.equal(B.me().swimming, false);
  assert.ok(dry(B.me()));
});

test('rescue: throw a lifebuoy, the swimmer grabs it and is pulled up beside the rescuer', async () => {
  clock += 10_000;
  const { A, B } = await shore();
  assert.equal((await A.sock.request('rescue:throw')).error, 'NO_SWIMMER', 'nobody in the water');
  assert.equal((await B.sock.request('rescue:grab')).error, 'NOT_SWIMMING');
  await dunk(A, B);
  assert.equal((await B.sock.request('rescue:grab')).error, 'NO_OFFER', 'nobody threw anything yet');
  assert.equal((await B.sock.request('rescue:throw')).error, 'SWIMMING', 'a swimmer cannot rescue');

  const offered = new Promise((r) => B.sock.once('rescue:event', r));
  assert.deepEqual(await A.sock.request('rescue:throw'), { ok: true });
  assert.deepEqual(await A.sock.request('rescue:throw').then((r) => r.error), 'COOLDOWN');
  const offer = await offered;
  assert.equal(offer.type, 'offer');
  assert.deepEqual([offer.by, offer.to], [A.pid, B.pid]);
  assert.equal(offer.until - clock, RESCUE_OFFER_MS);

  const done = new Promise((r) => A.sock.on('rescue:event', (e) => e.type === 'done' && r(e)));
  const corrected = new Promise((r) => B.sock.once('player:correct', r));
  assert.deepEqual(await B.sock.request('rescue:grab'), { ok: true });
  const end = await done;
  assert.deepEqual([end.by, end.saved], [A.pid, B.pid]);
  assert.equal(B.me().swimming, false);
  assert.ok(dry(B.me()), 'on dry ground');
  assert.ok(Math.hypot(B.me().x - A.me().x, B.me().y - A.me().y) <= 64, 'beside the rescuer');
  assert.deepEqual(await corrected, { x: B.me().x, y: B.me().y });
  assert.equal(A.me().stats.rescues, 1, 'counted for the rescuer');
  assert.equal(B.me().stats.rescues, 0);
});

test('rescue limits: out of range, the offer expires, and only a nearby rescuer on land counts', async () => {
  clock += 10_000;
  const { A, B } = await shore();
  await dunk(A, B);
  A.put(WATER_RECT.x - 22 - RESCUE_RANGE, midY, 'right');
  assert.equal((await A.sock.request('rescue:throw')).error, 'NO_SWIMMER', 'too far to throw');
  A.put(WATER_RECT.x - 22, midY, 'right');
  clock += 2000;
  assert.deepEqual(await A.sock.request('rescue:throw'), { ok: true });
  clock += RESCUE_OFFER_MS + 1;
  assert.equal((await B.sock.request('rescue:grab')).error, 'NO_OFFER', 'too late');
  clock += 2000;
  assert.deepEqual(await A.sock.request('rescue:throw'), { ok: true }, 'a new offer is possible');
  // the rescuer wanders off before the swimmer grabs
  A.put(WATER_RECT.x - 22 - RESCUE_RANGE - 40, midY, 'right');
  assert.equal((await B.sock.request('rescue:grab')).error, 'NO_OFFER', 'the rescuer is too far away to pull anyone up');
});

test('nobody comes: they climb out by themselves after a few seconds, and their screen follows', async () => {
  const quick = await createGameServer({ port: 0, graceMs: 200, swimMs: 150, world: false, now: () => clock });
  try {
    clock += 10_000;
    const { A, B } = await shore(quick);
    const moved = new Promise((r) => B.sock.once('player:correct', r));
    await dunk(A, B);
    assert.equal(B.me().swimming, true);
    const placed = await Promise.race([new Promise((r) => setTimeout(() => r(null), 1500)), (async () => { await moved; return true; })()]);
    assert.ok(placed, 'the swimmer was corrected (placed at the shore)');
    await wait(400);
    assert.equal(B.me().swimming, false, 'out of the water');
    assert.ok(dry(B.me()), 'on dry ground');
  } finally {
    sockets.forEach((s) => s.disconnect());
    await quick.close();
  }
});
