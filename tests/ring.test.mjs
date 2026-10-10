import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { io as connect } from 'socket.io-client';
import { createGameServer } from '../server/index.js';
import { insideRing, clampToRing, ringFloor } from '../src/systems/Combat.js';
import { isBlocked, bodyRect } from '../src/systems/Collision.js';
import { LAKE_MAP } from '../src/data/maps.js';

const DUEL = JSON.parse(readFileSync(new URL('../src/data/duel.json', import.meta.url), 'utf8'));
const RING = DUEL.ring;

test('the arena is on dry, open ground of the lake, with a spot for each fighter inside the ropes', () => {
  const f = ringFloor(RING);
  for (let x = f.x0; x <= f.x1; x += 4) for (let y = f.y0; y <= f.y1; y += 4) assert.equal(isBlocked(bodyRect(x, y, LAKE_MAP), LAKE_MAP), false, `blocked at ${x},${y}`);
  assert.equal(RING.spots.length, 2);
  for (const [x, y] of RING.spots) assert.ok(insideRing(RING, x, y));
  assert.ok(RING.spots[1][0] - RING.spots[0][0] >= 80, 'they start apart');
  const c = clampToRing(RING, 0, 0);
  assert.ok(insideRing(RING, c.x, c.y));
});

let server;
let clock = 60_000_000;
const sockets = [];
before(async () => {
  server = await createGameServer({ port: 0, graceMs: 200, world: false, now: () => clock, duel: { countdownMs: 40, durationMs: 600, acceptMs: 300, offerCooldownMs: 100, hp: 100 } });
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

async function startDuel() {
  const a = await client();
  const b = await client();
  const ha = await a.request('profile:hello', { name: 'Ann' });
  await b.request('profile:hello', { name: 'Ben' });
  const created = await a.request('room:create', { name: 'Ann' });
  const joined = await b.request('room:join', { code: created.room.code, name: 'Ben' });
  const playing = new Promise((r) => a.on('room:state', (s) => s.phase === 'playing' && r()));
  a.emit('room:ready', true);
  b.emit('room:ready', true);
  await playing;
  const room = server.rooms.rooms.get(created.room.code);
  const A = room.players.find((p) => p.pid === created.pid);
  const B = room.players.find((p) => p.pid === joined.pid);
  Object.assign(A, { x: 100, y: 430, facing: 'right' });
  Object.assign(B, { x: 130, y: 430, facing: 'left' });
  clock += 20_000;
  await a.request('duel:challenge');
  await b.request('duel:respond', { accept: true });
  return { a, b, A, B, room, ha };
}

test('a duel starts in the arena: both fighters are placed at their ends, and go back where they were afterwards', async () => {
  const { a, A, B, room } = await startDuel();
  assert.ok(room.duel, 'the duel is on');
  assert.deepEqual([A.x, A.y], RING.spots[0]);
  assert.deepEqual([B.x, B.y], RING.spots[1]);
  assert.ok(a.got.some(([ev, d]) => ev === 'player:correct' && d.x === RING.spots[0][0]), 'their screens are moved too');
  server.duels.cancelFor(A);
  assert.deepEqual([A.x, A.y], [100, 430]);
  assert.deepEqual([B.x, B.y], [130, 430]);
  assert.equal(room.duel, null);
});

test('inside the ropes you can move; trying to leave the ring is refused; a shove cannot send you out', async () => {
  const { a, A, B, room } = await startDuel();
  clock += 100;
  A.stunnedUntil = 0;
  B.stunnedUntil = 0;
  const f = ringFloor(RING);
  const t = clock;
  const ok = await new Promise((r) => { a.emit('player:state', { x: A.x + 6, y: A.y, facing: 'right', moving: true, t }); setTimeout(r, 80); });
  void ok;
  assert.ok(Math.abs(A.x - (RING.spots[0][0] + 6)) < 1.5, 'a step inside the ring is fine');
  a.emit('player:state', { x: f.x0 - 30, y: A.y, facing: 'left', moving: true, t: t + 10 });
  await new Promise((r) => setTimeout(r, 80));
  assert.ok(A.x >= f.x0, 'outside the ropes is refused');
  // a shove at the edge stays inside
  Object.assign(A, { x: f.x0 + 6, y: 448, facing: 'right' });
  Object.assign(B, { x: f.x0 + 4, y: 448, facing: 'left' });
  clock += 3000;
  await a.request('duel:act', { kind: 'push' });
  assert.ok(insideRing(RING, B.x, B.y), `pushed to ${B.x}`);
  server.duels.cancelFor(A);
  assert.ok(room);
});
