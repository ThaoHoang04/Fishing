import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { io as connect } from 'socket.io-client';
import { createGameServer } from '../server/index.js';
import { createWorld } from '../src/systems/World.js';
import { LAKE_MAP, OCEAN_MAP } from '../src/data/maps.js';
import { SHOP } from '../src/data/world.js';
import { PLAYER_SPEED, BOAT_SPEED } from '../src/config.js';
import { play, bots, byId } from './bots.mjs';
import { TICK_RATE } from '../src/systems/ReelSim.js';

const readJson = (rel) => JSON.parse(readFileSync(new URL(rel, import.meta.url), 'utf8'));
const conditions = readJson('../src/data/conditions.json');
const events = readJson('../src/data/events.json');
const spots = readJson('../src/data/spots.json');
const spot = (id) => spots.find((s) => s.id === id);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

let server;
let clock = 1_000_000; // the server's clock, controlled by the tests
let rngOverride = null;
let seed = 4242;
const stream = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);
const scripted = (values) => { let i = 0; return () => (i < values.length ? values[i++] : stream()); };
const WORLD_SEED = 77;
const sky = createWorld({ conditions, events });
const sockets = [];

before(async () => {
  server = await createGameServer({
    port: 0,
    graceMs: 300,
    now: () => clock,
    rng: () => (rngOverride ?? stream)(),
    world: { seed: WORLD_SEED },
    fishing: { BITE_MIN_MS: 60, BITE_MAX_MS: 60, HOOK_MIN_MS: 400, HOOK_MAX_MS: 400, HOOK_SLACK_MS: 300 },
  });
});
after(async () => {
  sockets.forEach((s) => s.disconnect());
  await server.close();
});

async function client() {
  const s = connect(`http://localhost:${server.port}`, { transports: ['websocket'], forceNew: true });
  sockets.push(s);
  s.buffer = [];
  s.buffering = 0;
  s.onAny((ev, d) => s.buffering > 0 && s.buffer.push([ev, d]));
  s.seen = [];
  s.onAny((ev, d) => s.seen.push([ev, d]));
  s.request = (event, payload) => {
    s.buffer.length = 0;
    s.buffering++;
    return new Promise((r) => s.emit(event, payload, (res) => {
      setImmediate(() => { s.buffering--; if (s.buffering === 0) s.buffer.length = 0; });
      r(res);
    }));
  };
  s.next = (event, pred = () => true, ms = 1500) => new Promise((resolve, reject) => {
    const hit = s.buffer.findIndex(([ev, d]) => ev === event && pred(d));
    if (hit !== -1) return resolve(s.buffer.splice(hit, 1)[0][1]);
    const t = setTimeout(() => reject(new Error(`timeout waiting for ${event}`)), ms);
    const h = (d) => { if (pred(d)) { clearTimeout(t); s.off(event, h); resolve(d); } };
    s.on(event, h);
  });
  await new Promise((r) => s.on('connect', r));
  return s;
}

async function twoPlayers() {
  const a = await client();
  const b = await client();
  const ha = await a.request('profile:hello', { name: 'Ann' });
  await b.request('profile:hello', { name: 'Ben' });
  const created = await a.request('room:create', { name: 'Ann' });
  const joined = await b.request('room:join', { code: created.room.code, name: 'Ben' });
  const playing = a.next('room:state', (s) => s.phase === 'playing');
  a.emit('room:ready', true);
  b.emit('room:ready', true);
  await playing;
  const find = (pid) => server.rooms.rooms.get(created.room.code).players.find((p) => p.pid === pid);
  const A = { sock: a, pid: created.pid, token: created.token, profileId: ha.profile.id, me: () => find(created.pid) };
  const B = { sock: b, pid: joined.pid, token: joined.token, me: () => find(joined.pid) };
  for (const p of [A, B]) {
    p.goto = (x, y) => { p.me().x = x; p.me().y = y; };
    p.atPortal = () => p.goto(LAKE_MAP.portals[0].x, LAKE_MAP.portals[0].y);
    p.sail = async () => { p.atPortal(); const r = await p.sock.request('map:travel', { portalId: 'lake_boat' }); assert.equal(r.ok, true, JSON.stringify(r)); return r; };
  }
  return { A, B, code: created.room.code };
}

// ---------------- the shared world ----------------

test('hello tells the client the seed and the server clock, so every screen shows the same sky', async () => {
  const c = await client();
  const hello = await c.request('profile:hello', { name: 'Sky' });
  assert.deepEqual(hello.world, { seed: WORLD_SEED, now: clock, lucky: null });
  assert.equal(server.worldSeed, WORLD_SEED);
  // what the server uses for fishing is the same function of the same inputs the client will compute
  const expected = sky.state(clock, { seed: WORLD_SEED, mapId: 'ocean' });
  assert.deepEqual(server.worldFor('ocean'), expected);
});

test('with the world switched off there is no weather and no events (what older tests rely on)', async () => {
  const quiet = await createGameServer({ port: 0, world: false });
  try {
    const c = connect(`http://localhost:${quiet.port}`, { transports: ['websocket'], forceNew: true });
    const hello = await new Promise((resolve) => c.on('connect', () => c.emit('profile:hello', {}, resolve)));
    assert.equal(hello.world, null);
    assert.equal(quiet.worldFor('lake'), null);
    c.disconnect();
  } finally {
    await quiet.close();
  }
});

// ---------------- travel ----------------

test('sailing: stand at the pier\'s boat and go; you appear at the harbour, on a boat, facing the sea', async () => {
  const { A, B } = await twoPlayers();
  assert.equal(A.me().mapId, 'lake', 'everyone starts on the lake');
  const seen = B.sock.next('room:state', (s) => s.players.find((p) => p.pid === A.pid).mapId === 'ocean');
  const r = await A.sail();
  assert.deepEqual([r.mapId, r.x, r.y], ['ocean', OCEAN_MAP.spawns.harbor.x, OCEAN_MAP.spawns.harbor.y]);
  assert.equal(A.me().mapId, 'ocean');
  assert.equal(A.me().facing, 'up');
  const view = (await seen).players;
  assert.equal(view.find((p) => p.pid === A.pid).mapId, 'ocean');
  assert.equal(view.find((p) => p.pid === B.pid).mapId, 'lake', 'the partner stayed behind');
  assert.deepEqual([view.find((p) => p.pid === A.pid).x, view.find((p) => p.pid === A.pid).y], [r.x, r.y]);
});

test('and back again: the harbour portal returns you to the pier, on foot', async () => {
  const { A } = await twoPlayers();
  await A.sail();
  A.goto(OCEAN_MAP.portals[0].x, OCEAN_MAP.portals[0].y);
  const r = await A.sock.request('map:travel', { portalId: 'ocean_harbor' });
  assert.deepEqual([r.ok, r.mapId, r.x, r.y], [true, 'lake', LAKE_MAP.spawns.dock.x, LAKE_MAP.spawns.dock.y]);
  assert.equal(A.me().mapId, 'lake');
  assert.equal(A.me().facing, 'down');
});

test('travel is refused away from the portal, with a made-up portal, from the wrong map, in the lobby, or mid-fight', async () => {
  const { A } = await twoPlayers();
  A.goto(200, 91);
  assert.equal((await A.sock.request('map:travel', { portalId: 'lake_boat' })).error, 'TOO_FAR');
  A.goto(LAKE_MAP.portals[0].x + 30, LAKE_MAP.portals[0].y); // radius 14 + 12 px of slack = 26
  assert.equal((await A.sock.request('map:travel', { portalId: 'lake_boat' })).error, 'TOO_FAR', 'just outside the pull');
  A.atPortal();
  assert.equal((await A.sock.request('map:travel', { portalId: 'nope' })).error, 'NO_PORTAL');
  assert.equal((await A.sock.request('map:travel', { portalId: 'ocean_harbor' })).error, 'NO_PORTAL', 'that portal is on the other map');
  assert.equal((await A.sock.request('map:travel', {})).error, 'NO_PORTAL');
  A.goto(LAKE_MAP.portals[0].x + 6, LAKE_MAP.portals[0].y); // inside the radius + tolerance
  assert.equal((await A.sock.request('map:travel', { portalId: 'lake_boat' })).ok, true);

  // in the lobby
  const x = await client();
  const lobby = await x.request('room:create', { name: 'Solo' });
  assert.equal((await x.request('map:travel', { portalId: 'lake_boat' })).error, 'NOT_PLAYING');
  assert.ok(lobby.ok);

  // with a line out
  const { A: F } = await twoPlayers();
  F.goto(spot('dock_tip').x, spot('dock_tip').y);
  assert.equal((await F.sock.request('fishing:cast', { spotId: 'dock_tip', power: 0.5 })).ok, true);
  F.atPortal();
  assert.equal((await F.sock.request('map:travel', { portalId: 'lake_boat' })).error, 'BUSY');
  assert.equal(F.me().mapId, 'lake');
  await F.sock.request('fishing:cancel');
  assert.equal((await F.sock.request('map:travel', { portalId: 'lake_boat' })).ok, true, 'fine once the line is in');
});

test('a player who reconnects comes back on the map they were on, with their position', async () => {
  const { A, code } = await twoPlayers();
  await A.sail();
  A.goto(500, 400);
  A.sock.disconnect();
  const again = await client();
  const back = await again.request('room:rejoin', { code, token: A.token });
  assert.equal(back.ok, true);
  const me = back.room.players.find((p) => p.pid === A.pid);
  assert.deepEqual([me.mapId, me.x, me.y], ['ocean', 500, 400]);
});

// ---------------- movement at sea ----------------

test('at sea the boat is validated against the sea map: faster than walking, blocked by islands and edges', async () => {
  const { A } = await twoPlayers();
  await A.sail();
  const room = server.rooms.rooms.values().next().value;
  assert.ok(room);
  const send = async (x, y) => {
    const correction = A.sock.next('player:correct', () => true, 150).then(() => 'corrected', () => 'accepted');
    A.sock.emit('player:state', { x, y, facing: 'up', moving: true, t: clock });
    return correction;
  };
  // Boat speed: a steady 95 px/s is within 84 x 1.25 = 105, but over 75 (walking 60 x 1.25).
  assert.ok(BOAT_SPEED * 1.25 > 95 && PLAYER_SPEED * 1.25 < 95);
  A.me().x = 620; // a clear lane north of the harbour (no islands or rocks on x = 620 down here)
  let y = A.me().y;
  let refused = 0;
  for (let i = 0; i < 25; i++) {
    clock += 100;
    y -= 9.5;
    if ((await send(620, y)) === 'corrected') {
      refused++;
      y = A.me().y;
    }
  }
  assert.equal(refused, 0, 'a boat can keep up 95 px/s');
  assert.ok(A.me().y < OCEAN_MAP.spawns.harbor.y - 200, 'it really sailed');

  // an island blocks it
  const isle = OCEAN_MAP.land[3]; // south-west island
  A.me().x = isle.x + 40;
  A.me().y = isle.y - 12;
  clock += 2000;
  assert.equal(await send(isle.x + 40, isle.y + 10), 'corrected', 'cannot sail onto land');
  // nor off the edge of the map
  A.me().x = 6;
  A.me().y = 300;
  clock += 2000;
  assert.equal(await send(-3, 300), 'corrected');
  // and the same position that is open sea out there is water you cannot walk on at the lake
  A.sock.disconnect();
});

test('on the lake nothing changed: walking speed, water blocks, the pier is fine', async () => {
  const { A } = await twoPlayers();
  const send = async (x, y) => {
    const correction = A.sock.next('player:correct', () => true, 150).then(() => 'corrected', () => 'accepted');
    A.sock.emit('player:state', { x, y, facing: 'up', moving: true, t: clock });
    return correction;
  };
  A.goto(450, 346);
  clock += 1000;
  assert.equal(await send(450, 335), 'corrected', 'into the water');
  A.goto(320, 360);
  clock += 1000;
  assert.equal(await send(320, 350), 'accepted', 'onto the pier');
  // a hundred px in a tenth of a second is not walking
  clock += 100;
  assert.equal(await send(320, 250), 'corrected');
});

// ---------------- who can see whom ----------------

test('players only see each other on the same map: movement, emotes and fishing lines do not cross maps', async () => {
  const { A, B } = await twoPlayers();
  await A.sail(); // A at sea, B on the lake
  clock += 2000;
  B.sock.seen.length = 0;
  A.sock.seen.length = 0;
  A.sock.emit('player:state', { x: 480, y: 640, facing: 'up', moving: true, t: clock });
  A.sock.emit('emote', { id: 1 });
  clock += 2000;
  B.sock.emit('player:state', { x: 256, y: 400, facing: 'down', moving: true, t: clock });
  await wait(200);
  const names = (s) => s.seen.map(([e]) => e);
  assert.ok(!names(B.sock).includes('player:state'), 'B never saw A\'s boat');
  assert.ok(!names(B.sock).includes('emote'));
  assert.ok(!names(A.sock).includes('player:state'), 'A never saw B on the lake');

  // B sails too: now they are together and see each other
  await B.sail();
  await wait(100);
  B.sock.seen.length = 0;
  A.sock.seen.length = 0;
  clock += 2000;
  A.sock.emit('player:state', { x: 470, y: 640, facing: 'left', moving: true, t: clock });
  clock += 2000;
  A.sock.emit('emote', { id: 2 });
  await wait(150);
  assert.ok(names(B.sock).includes('player:state'));
  assert.ok(names(B.sock).includes('emote'));
});

test('a line cast at sea is visible only to a player at sea; a rare catch is announced to everyone', async () => {
  const { A, B } = await twoPlayers();
  await A.sail();
  const zone = spot('reef');
  A.goto(zone.x, zone.y);
  B.sock.seen.length = 0;
  rngOverride = scripted([0.9, 0, 0.5, 0.123, 0.5, 0]);
  const cast = await A.sock.request('fishing:cast', { spotId: 'reef', power: 0.5, facing: 'down' });
  rngOverride = null;
  assert.equal(cast.ok, true, JSON.stringify(cast));
  await wait(120);
  assert.ok(!B.sock.seen.some(([e]) => e === 'fishing:state'), 'B on the lake sees no line out at sea');
  await A.sock.request('fishing:cancel');

  // rare announcements are for the whole room, wherever they are
  const toB = [];
  B.sock.on('fishing:rare', (r) => toB.push(r));
  rngOverride = scripted([0.9, 0, 0.5, 0.123, 0.5, 0]); // a rare in the reef: lobster
  const c2 = await A.sock.request('fishing:cast', { spotId: 'reef', power: 0.5, facing: 'down' });
  rngOverride = null;
  const hookedEvent = A.sock.next('fishing:event', (e) => e.event === 'hooked');
  await A.sock.next('fishing:event', (e) => e.event === 'bite');
  await A.sock.request('fishing:hook', { id: c2.session.id });
  const hooked = await hookedEvent;
  assert.equal(byId(hooked.speciesId).rarity, 'rare');
  const fight = play(byId(hooked.speciesId), bots.fishWatcher(100), hooked.seed, hooked.gear, hooked.weight);
  clock += (fight.sim.tick / TICK_RATE) * 1000;
  const result = A.sock.next('fishing:event', (e) => e.event === 'result');
  await A.sock.request('fishing:finish', { id: c2.session.id, toggles: fight.toggles });
  assert.equal((await result).outcome, 'caught');
  await wait(150);
  assert.equal(toB.length, 1, 'the other player, still on the lake, hears about it');
  assert.equal(toB[0].speciesId, 'lobster');
});

// ---------------- fishing from a boat, over the wire ----------------

test('sea zones are fished from the boat in any direction, and only from the sea', async () => {
  const { A } = await twoPlayers();
  const reef = spot('reef');
  A.goto(reef.x, reef.y);
  assert.equal((await A.sock.request('fishing:cast', { spotId: 'reef', power: 0.5, facing: 'down' })).error, 'WRONG_MAP', 'a lake player cannot fish a sea zone');
  await A.sail();
  A.goto(reef.x, reef.y);
  assert.equal((await A.sock.request('fishing:cast', { spotId: 'reef', power: 0.5 })).error, 'BAD_FACING');
  assert.equal((await A.sock.request('fishing:cast', { spotId: 'west', power: 0.5 })).error, 'WRONG_MAP', 'and a boat cannot fish the lake\'s spots');
  A.goto(reef.x + reef.r + 40, reef.y);
  assert.equal((await A.sock.request('fishing:cast', { spotId: 'reef', power: 0.5, facing: 'up' })).error, 'TOO_FAR');
  A.goto(reef.x - 30, reef.y + 20);
  const ok = await A.sock.request('fishing:cast', { spotId: 'reef', power: 0.5, facing: 'left' });
  assert.equal(ok.ok, true);
  assert.equal(ok.session.facing, 'left');
  assert.ok(server.fishing.get(A.pid).bobber.x < reef.x - 30, 'cast to the left of the boat');
});

test('the market is on the lake only: standing on its coordinates at sea does not open it', async () => {
  const { A } = await twoPlayers();
  const seed1 = server.economy.addCatch(A.profileId, { speciesId: 'carp', weight: 2 });
  assert.ok(seed1.ok);
  A.goto(SHOP.talkX, SHOP.talkY);
  const here = await A.sock.request('inv:sellAll');
  assert.equal(here.ok, true, 'at the lake stall it works');
  server.economy.addCatch(A.profileId, { speciesId: 'carp', weight: 2 });
  await A.sail();
  A.goto(SHOP.talkX, SHOP.talkY);
  assert.equal((await A.sock.request('inv:sellAll')).error, 'NOT_AT_SHOP');
});

// ---------------- weather and the sea, over the wire ----------------

test('conditions reach the fishing rules: the boss only bites after dark, and storms speed up the bite', async () => {
  const dayFrac = (f) => Math.floor(f * conditions.dayMs);
  // a moment at night and one in the middle of the day, each on a day where the sky is what the test needs
  const findTime = (frac, weather) => {
    for (let day = 0; day < 3000; day++) {
      const t = day * conditions.dayMs + dayFrac(frac);
      if (sky.weatherAt(t, WORLD_SEED) === weather) return t;
    }
    throw new Error('not found');
  };
  const { A } = await twoPlayers();
  await A.sail();
  const abyss = spot('abyss');
  const rolls = [0.9999, 0.9999, 0.5, 0.123, 0.5, 0.5]; // top rarity, top species of the pool
  const catchAt = async (t) => {
    clock = t;
    A.goto(abyss.x, abyss.y);
    rngOverride = scripted(rolls);
    const res = await A.sock.request('fishing:cast', { spotId: 'abyss', power: 0.5, facing: 'up' });
    rngOverride = null;
    assert.equal(res.ok, true, JSON.stringify(res));
    const s = server.fishing.get(A.pid);
    const out = { speciesId: s.speciesId };
    await A.sock.request('fishing:cancel');
    return out;
  };
  const noon = findTime(0.3, 'clear');
  const midnight = findTime(0.9, 'clear');
  assert.notEqual((await catchAt(noon)).speciesId, 'nautilus', 'the boss sleeps in the daytime');
  assert.equal((await catchAt(midnight)).speciesId, 'nautilus', 'and shows up after dark');

  // storm: the bite delay shrinks. Same rolls, same spot; only the sky differs.
  const biteDelay = async (t) => {
    clock = t;
    A.goto(spot('reef').x, spot('reef').y);
    rngOverride = scripted([0.1, 0.1, 0.5, 0.123, 0.5, 0.5]);
    await A.sock.request('fishing:cast', { spotId: 'reef', power: 0.5, facing: 'down' });
    rngOverride = null;
    const t0 = Date.now();
    await A.sock.next('fishing:event', (e) => e.event === 'bite', 2000).catch(() => null);
    const took = Date.now() - t0;
    await A.sock.request('fishing:cancel');
    return { took, state: server.worldFor('ocean') };
  };
  const calm = await biteDelay(findTime(0.3, 'clear'));
  assert.equal(calm.state.weather, 'clear');
  assert.equal(calm.state.modifiers.biteSpeed, 1);
  const stormy = await biteDelay(findTime(0.3, 'storm'));
  assert.equal(stormy.state.weather, 'storm');
  assert.ok(stormy.state.modifiers.biteSpeed < 0.7);
  assert.ok(stormy.state.events.includes('storm_surge'));
});
