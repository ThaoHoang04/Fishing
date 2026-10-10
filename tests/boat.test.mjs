import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { io as connect } from 'socket.io-client';
import { createGameServer } from '../server/index.js';
import { LAKE_MAP, OCEAN_MAP } from '../src/data/maps.js';
import { BOARD_RANGE, BOAT_STILL_MS } from '../server/rooms.js';

const spots = JSON.parse(readFileSync(new URL('../src/data/spots.json', import.meta.url), 'utf8'));
const reef = spots.find((s) => s.id === 'reef');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

let server;
let clock = 5_000_000;
const sockets = [];
before(async () => {
  server = await createGameServer({
    port: 0,
    graceMs: 200,
    world: false,
    now: () => clock,
    fishing: { BITE_MIN_MS: 5000, BITE_MAX_MS: 5000, HOOK_MIN_MS: 400, HOOK_MAX_MS: 400 }, // the line stays out while we test
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
  await new Promise((r) => s.on('connect', r));
  return s;
}

/** Two players in a running game, both sailed out to the harbour of the open ocean. */
async function atSea() {
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
  const mk = (sock, pid) => {
    const p = { sock, pid, me: () => find(pid) };
    p.goto = (x, y) => { p.me().x = x; p.me().y = y; };
    p.sail = async () => {
      p.goto(LAKE_MAP.portals[0].x, LAKE_MAP.portals[0].y);
      const r = await sock.request('map:travel', { portalId: 'lake_boat' });
      assert.equal(r.ok, true, JSON.stringify(r));
    };
    p.move = (x, y, facing = 'up') => { clock += 100; sock.emit('player:state', { x, y, facing, moving: true, t: clock }); return wait(60); };
    return p;
  };
  const A = mk(a, created.pid);
  const B = mk(b, joined.pid);
  await A.sail();
  await B.sail();
  clock += 5000;
  return { A, B, view: () => server.rooms.rooms.get(created.room.code) };
}

test('boarding: the other player\'s boat, close by, at sea; the boarded player drives', async () => {
  const { A, B, view } = await atSea();
  A.goto(300, 400);
  B.goto(300 + BOARD_RANGE + 10, 400);
  assert.equal((await B.sock.request('boat:board')).error, 'TOO_FAR');
  B.goto(300 + BOARD_RANGE - 5, 400);
  const seen = new Promise((r) => A.sock.on('room:state', (s) => s.players.some((p) => p.seat) && r(s)));
  assert.deepEqual(await B.sock.request('boat:board'), { ok: true });
  assert.equal(B.me().seat, 'passenger');
  assert.equal(A.me().seat, 'driver');
  assert.equal(B.me().boatWith.pid, A.pid);
  assert.deepEqual([B.me().x, B.me().y], [300, 400], 'the passenger is on the boat');
  const room = await seen;
  assert.deepEqual(room.players.map((p) => [p.seat, p.boatWith]).sort(), [['driver', B.pid], ['passenger', A.pid]].sort());
  assert.ok(!JSON.stringify(room).includes('"token"'));
  assert.equal(view().players.length, 2);

  assert.equal((await B.sock.request('boat:board')).error, 'ALREADY_ABOARD');
  assert.equal((await A.sock.request('boat:board')).error, 'ALREADY_ABOARD');
});

test('boarding is refused on foot, on another map, or with nobody to join', async () => {
  const a = await client();
  const b = await client();
  const created = await a.request('room:create', { name: 'A' });
  await b.request('room:join', { code: created.room.code, name: 'B' });
  assert.equal((await b.request('boat:board')).error, 'NOT_PLAYING', 'not in a running game');

  const { A, B } = await atSea();
  A.goto(300, 400);
  B.goto(300, 400);
  await B.sock.request('boat:leave'); // not aboard
  assert.equal((await B.sock.request('boat:leave')).error, 'NOT_ABOARD');
  assert.equal((await B.sock.request('boat:switch')).error, 'NOT_ABOARD');

  // B goes home to the lake: A cannot board nobody, B cannot board on foot
  B.goto(OCEAN_MAP.portals[0].x, OCEAN_MAP.portals[0].y);
  assert.equal((await B.sock.request('map:travel', { portalId: 'ocean_harbor' })).ok, true);
  assert.equal((await A.sock.request('boat:board')).error, 'NO_BOAT');
  assert.equal((await B.sock.request('boat:board')).error, 'WRONG_MAP');
});

test('the passenger rides: the driver\'s moves carry both, the passenger cannot steer', async () => {
  const { A, B } = await atSea();
  A.goto(300, 400);
  B.goto(310, 400);
  await B.sock.request('boat:board');
  await A.move(300, 392);
  assert.deepEqual([A.me().x, A.me().y], [300, 392]);
  assert.deepEqual([B.me().x, B.me().y], [300, 392], 'the passenger moved with the boat');

  // the passenger's own position reports are ignored; only a valid facing is taken
  const toA = [];
  A.sock.on('player:state', (s) => toA.push(s));
  B.sock.emit('player:state', { x: 100, y: 100, facing: 'left', moving: true, t: clock });
  await wait(80);
  assert.deepEqual([B.me().x, B.me().y], [300, 392]);
  assert.equal(B.me().facing, 'left');
  assert.deepEqual(toA.at(-1) && [toA.at(-1).x, toA.at(-1).y, toA.at(-1).facing], [300, 392, 'left'], 'the driver sees where the passenger looks, on the boat');
  const bad = [];
  B.sock.on('player:correct', (c) => bad.push(c));
  B.sock.emit('player:state', { x: 1, y: 1, facing: 'sideways', moving: false, t: clock });
  await wait(80);
  assert.deepEqual(bad, [{ x: 300, y: 392 }], 'junk is answered with the boat\'s position');
  assert.equal(B.me().facing, 'left');
});

test('fishing from a shared boat: only when it is stopped; the boat then holds still', async () => {
  const { A, B } = await atSea();
  A.goto(reef.x, reef.y);
  B.goto(reef.x + 6, reef.y);
  await B.sock.request('boat:board');

  await A.move(reef.x + 1, reef.y);
  assert.equal((await B.sock.request('fishing:cast', { spotId: 'reef', power: 0.5, facing: 'down' })).error, 'BOAT_MOVING', 'just moved');
  assert.equal((await A.sock.request('fishing:cast', { spotId: 'reef', power: 0.5, facing: 'down' })).error, 'BOAT_MOVING', 'the driver too');
  clock += BOAT_STILL_MS;
  const cast = await B.sock.request('fishing:cast', { spotId: 'reef', power: 0.5, facing: 'left' });
  assert.equal(cast.ok, true, JSON.stringify(cast));

  // the driver cannot sail off while the passenger's line is out; the same input is refused and corrected
  const corrections = [];
  A.sock.on('player:correct', (c) => corrections.push(c));
  const before = [A.me().x, A.me().y];
  await A.move(reef.x + 12, reef.y);
  assert.deepEqual([A.me().x, A.me().y], before);
  assert.equal(corrections.length, 1);
  // nobody can change seat, leave or sail with a line out
  assert.equal((await B.sock.request('boat:leave')).error, 'BUSY');
  assert.equal((await A.sock.request('boat:switch')).error, 'BUSY');
  A.goto(OCEAN_MAP.portals[0].x, OCEAN_MAP.portals[0].y);
  assert.equal((await A.sock.request('map:travel', { portalId: 'ocean_harbor' })).error, 'BUSY');

  await B.sock.request('fishing:cancel');
  A.goto(reef.x, reef.y);
  await A.move(reef.x + 12, reef.y);
  assert.equal(A.me().x, reef.x + 12, 'free to sail again once the line is in');
});

test('swapping seats: the driver and the passenger trade roles; the boat stays where it is', async () => {
  const { A, B } = await atSea();
  A.goto(300, 400);
  B.goto(300, 400);
  await B.sock.request('boat:board');
  assert.deepEqual(await A.sock.request('boat:switch'), { ok: true, seat: 'passenger' });
  assert.equal(A.me().seat, 'passenger');
  assert.equal(B.me().seat, 'driver');
  assert.deepEqual([A.me().x, A.me().y], [B.me().x, B.me().y]);
  clock += 1000;
  await B.move(300, 392);
  assert.deepEqual([A.me().x, A.me().y], [300, 392], 'the new driver steers; the old one rides');
  const before = [B.me().x, B.me().y];
  await A.move(250, 392);
  assert.deepEqual([B.me().x, B.me().y], before, 'the new passenger cannot steer');
});

test('stepping off: into the water beside the boat, never into an island; the boat is the driver\'s again', async () => {
  const { A, B } = await atSea();
  A.goto(300, 400);
  B.goto(300, 400);
  await B.sock.request('boat:board');
  const left = await B.sock.request('boat:leave');
  assert.equal(left.ok, true);
  assert.equal(B.me().seat, null);
  assert.equal(A.me().seat, null);
  assert.ok(Math.hypot(left.x - 300, left.y - 400) > 10, 'beside the boat');
  assert.deepEqual([B.me().x, B.me().y], [left.x, left.y]);
  clock += 1000;
  await B.move(left.x, left.y + 6);
  assert.equal(B.me().y, left.y + 6, 'on their own boat again');
  assert.equal((await A.sock.request('boat:leave')).error, 'NOT_ABOARD');
});

test('the driver sails the crew home; the passenger cannot; both arrive on the lake on foot and the crew is dissolved', async () => {
  const { A, B } = await atSea();
  A.goto(OCEAN_MAP.portals[0].x, OCEAN_MAP.portals[0].y);
  B.goto(OCEAN_MAP.portals[0].x + 4, OCEAN_MAP.portals[0].y);
  await B.sock.request('boat:board');
  assert.equal((await B.sock.request('map:travel', { portalId: 'ocean_harbor' })).error, 'PASSENGER');
  assert.equal((await A.sock.request('map:travel', { portalId: 'ocean_harbor' })).ok, true);
  for (const p of [A, B]) {
    assert.equal(p.me().mapId, 'lake');
    assert.equal(p.me().seat, null);
    assert.equal(p.me().boatWith, null);
  }
});

test('a crew member who disconnects or leaves does not strand the other', async () => {
  const one = await atSea();
  one.A.goto(300, 400);
  one.B.goto(300, 400);
  await one.B.sock.request('boat:board');
  one.B.sock.disconnect();
  await wait(100);
  assert.equal(one.A.me().seat, null, 'the driver is alone again');
  clock += 1000;
  await one.A.move(300, 392);
  assert.equal(one.A.me().y, 392);

  const two = await atSea();
  two.A.goto(300, 400);
  two.B.goto(300, 400);
  await two.B.sock.request('boat:board');
  await two.A.sock.request('room:leave');
  await wait(100);
  assert.equal(two.B.me().seat, null);
  assert.equal(two.B.me().boatWith, null);
});
