import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { io as connect } from 'socket.io-client';
import { createGameServer } from '../server/index.js';
import { PLAYER_SPAWNS } from '../src/data/world.js';
import { readFileSync } from 'node:fs';
import { play, bots, byId } from './bots.mjs';
import { RARITIES } from '../src/systems/FishingRules.js';
import { TICK_RATE } from '../src/systems/ReelSim.js';

const SPOTS = JSON.parse(readFileSync(new URL('../src/data/spots.json', import.meta.url), 'utf8'));
const spot = (id) => SPOTS.find((x) => x.id === id);

let server;
let skewMs = 0; // lets a test fast-forward the server's clock (the fight's real-time check)
let rngOverride = null; // a test can script the next rolls
let streamSeed = 424242;
const stream = () => ((streamSeed = (streamSeed * 1664525 + 1013904223) % 4294967296) / 4294967296);
const scripted = (values) => { let i = 0; return () => (i < values.length ? values[i++] : stream()); };
const clients = [];

before(async () => {
  server = await createGameServer({
    port: 0,
    world: false, // no weather: these tests script their own rolls
    graceMs: 300,
    now: () => Date.now() + skewMs,
    rng: () => (rngOverride ?? stream)(),
    fishing: { BITE_MIN_MS: 80, BITE_MAX_MS: 80, HOOK_MIN_MS: 200, HOOK_MAX_MS: 200, HOOK_SLACK_MS: 60 },
  });
});
after(async () => {
  clients.forEach((c) => c.disconnect());
  await server.close();
});

async function client() {
  const s = connect(`http://localhost:${server.port}`, { transports: ['websocket'], forceNew: true });
  clients.push(s);
  await new Promise((r) => s.on('connect', r));
  // Events that arrive in the same packet as a request's ack are handled before the test can start listening.
  // Keep what arrives from the request until the end of the tick that processes its ack; nothing older ever matches.
  s.buffer = [];
  s.buffering = 0;
  s.onAny((ev, d) => s.buffering > 0 && s.buffer.push([ev, d]));
  s.request = (event, payload) => {
    s.buffer.length = 0;
    s.buffering++;
    return new Promise((r) => s.emit(event, payload, (res) => {
      setImmediate(() => { s.buffering--; if (s.buffering === 0) s.buffer.length = 0; });
      r(res);
    }));
  };
  s.next = (event, pred = () => true, ms = 1500) =>
    new Promise((resolve, reject) => {
      const seen = s.buffer.findIndex(([ev, d]) => ev === event && pred(d));
      if (seen !== -1) return resolve(s.buffer.splice(seen, 1)[0][1]);
      const t = setTimeout(() => reject(new Error(`timeout waiting for ${event}`)), ms);
      const h = (d) => { if (pred(d)) { clearTimeout(t); s.off(event, h); resolve(d); } };
      s.on(event, h);
    });
  return s;
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function startedRoom() {
  const a = await client();
  const b = await client();
  const created = await a.request('room:create', { name: 'Alice' });
  const joined = await b.request('room:join', { code: created.room.code, name: 'Bob' });
  const playing = a.next('room:state', (s) => s.phase === 'playing');
  a.emit('room:ready', true);
  b.emit('room:ready', true);
  await playing;
  return { a, b, created, joined };
}

test('create room returns a 4-char code, a token and slot 0', async () => {
  const a = await client();
  const res = await a.request('room:create', { name: 'Alice' });
  assert.equal(res.ok, true);
  assert.match(res.room.code, /^[A-HJ-NP-Z2-9]{4}$/);
  assert.ok(res.token.length >= 16);
  assert.equal(res.room.players[0].slot, 0);
  assert.equal(res.room.phase, 'lobby');
  assert.equal(JSON.stringify(res.room).includes(res.token), false, 'token must not be in the public view');
});

test('a 3rd player is rejected with ROOM_FULL; unknown code is NOT_FOUND', async () => {
  const [a, b, c] = [await client(), await client(), await client()];
  const { room } = await a.request('room:create', { name: 'A' });
  assert.equal((await b.request('room:join', { code: room.code.toLowerCase(), name: 'B' })).ok, true);
  const third = await c.request('room:join', { code: room.code, name: 'C' });
  assert.deepEqual([third.ok, third.error], [false, 'ROOM_FULL']);
  const missing = await c.request('room:join', { code: 'ZZZZ', name: 'C' });
  assert.deepEqual([missing.ok, missing.error], [false, 'NOT_FOUND']);
});

test('players get distinct slots and skins; names are sanitized', async () => {
  const [a, b] = [await client(), await client()];
  const { room } = await a.request('room:create', { name: '  <b>Very long nickname here</b>  ' });
  const joined = await b.request('room:join', { code: room.code, name: '' });
  const [p1, p2] = joined.room.players;
  assert.notEqual(p1.skin, p2.skin);
  assert.deepEqual([p1.slot, p2.slot], [0, 1]);
  assert.ok(p1.name.length <= 12 && !/[<>]/.test(p1.name));
  assert.equal(p2.name, 'Angler');
});

test('game starts only when both players are ready', async () => {
  const [a, b] = [await client(), await client()];
  const { room } = await a.request('room:create', { name: 'A' });
  await b.request('room:join', { code: room.code, name: 'B' });
  a.emit('room:ready', true);
  await wait(100);
  assert.equal(server.rooms.rooms.get(room.code).phase, 'lobby');
  const started = a.next('room:state', (s) => s.phase === 'playing');
  b.emit('room:ready', true);
  const state = await started;
  assert.deepEqual(state.players.map((p) => [p.x, p.y]), PLAYER_SPAWNS.map((s) => [s.x, s.y]));
});

test('valid movement is relayed to the other player only', async () => {
  const { a, b } = await startedRoom();
  const spawn = PLAYER_SPAWNS[0];
  const got = b.next('player:state');
  let echoed = false;
  a.on('player:state', () => (echoed = true));
  a.emit('player:state', { x: spawn.x + 3, y: spawn.y, facing: 'right', moving: true, t: 123 });
  const s = await got;
  assert.deepEqual([s.x, s.y, s.facing, s.moving, s.t], [spawn.x + 3, spawn.y, 'right', true, 123]);
  await wait(100);
  assert.equal(echoed, false);
});

test('teleport / speed hacks are rejected and the client is corrected', async () => {
  const { a, b, created } = await startedRoom();
  const spawn = PLAYER_SPAWNS[0];
  let relayed = false;
  b.on('player:state', () => (relayed = true));
  const correction = a.next('player:correct');
  a.emit('player:state', { x: spawn.x + 200, y: spawn.y, facing: 'right', moving: true, t: 1 });
  assert.deepEqual(await correction, { x: spawn.x, y: spawn.y });
  await wait(100);
  assert.equal(relayed, false);
  assert.equal(created.room.players[0].pid.length > 0, true);
});

test('moves into water or off the map are rejected', async () => {
  const { a } = await startedRoom();
  for (const pos of [{ x: 300, y: 120 }, { x: -5, y: 100 }, { x: NaN, y: 100 }]) {
    const correction = a.next('player:correct');
    a.emit('player:state', { ...pos, facing: 'up', moving: true, t: 1 });
    await correction;
  }
});

test('bunched packets within the speed budget are not rejected', async () => {
  const { a, b } = await startedRoom();
  const spawn = PLAYER_SPAWNS[0];
  let corrected = false;
  a.on('player:correct', () => (corrected = true));
  const seen = [];
  b.on('player:state', (s) => seen.push(s.x));
  for (let i = 1; i <= 4; i++) a.emit('player:state', { x: spawn.x + i * 4, y: spawn.y, facing: 'right', moving: true, t: i });
  await wait(200);
  assert.equal(corrected, false);
  assert.deepEqual(seen, [spawn.x + 4, spawn.x + 8, spawn.x + 12, spawn.x + 16]);
});

test('disconnect keeps the slot, is announced, and the token reclaims it', async () => {
  const { a, b, created } = await startedRoom();
  const offline = b.next('room:state', (s) => s.players.some((p) => !p.connected));
  a.disconnect();
  const state = await offline;
  assert.equal(state.players.find((p) => p.pid === created.pid).connected, false);

  // Slot is still reserved: a stranger cannot take it.
  const stranger = await client();
  assert.equal((await stranger.request('room:join', { code: created.room.code, name: 'X' })).error, 'ROOM_FULL');

  const back = await client();
  const res = await back.request('room:rejoin', { code: created.room.code, token: created.token });
  assert.equal(res.ok, true);
  assert.equal(res.pid, created.pid);
  assert.equal(res.room.players.find((p) => p.pid === created.pid).connected, true);
});

test('wrong token cannot rejoin', async () => {
  const { created } = await startedRoom();
  const intruder = await client();
  const res = await intruder.request('room:rejoin', { code: created.room.code, token: 'nope' });
  assert.deepEqual([res.ok, res.error], [false, 'NOT_FOUND']);
});

test('slot is freed after the grace period; empty rooms are deleted', async () => {
  const a = await client();
  const b = await client();
  const { room } = await a.request('room:create', { name: 'A' });
  await b.request('room:join', { code: room.code, name: 'B' });
  const left = b.next('room:state', (s) => s.players.length === 1, 2000);
  a.disconnect();
  await left; // graceMs = 300 in this suite
  const c = await client();
  assert.equal((await c.request('room:join', { code: room.code, name: 'C' })).ok, true);
  c.disconnect();
  b.disconnect();
  await wait(700);
  assert.equal(server.rooms.rooms.has(room.code), false);
});

test('leaving frees the slot immediately', async () => {
  const [a, b, c] = [await client(), await client(), await client()];
  const { room } = await a.request('room:create', { name: 'A' });
  await b.request('room:join', { code: room.code, name: 'B' });
  await b.request('room:leave');
  const res = await c.request('room:join', { code: room.code, name: 'C' });
  assert.equal(res.ok, true);
  assert.equal(res.room.players.find((p) => p.name === 'C').slot, 1);
});

// ---- fishing over the wire ----
// Players spawn away from the spots and the server validates every move, so tests place them directly.
const place = (code, slot, spotId) => {
  const p = server.rooms.rooms.get(code).players.find((x) => x.slot === slot);
  p.x = spot(spotId).x;
  p.y = spot(spotId).y;
};

test('fishing: cast is refused in the lobby and when far from the spot', async () => {
  const [a, b] = [await client(), await client()];
  const { room } = await a.request('room:create', { name: 'A' });
  await b.request('room:join', { code: room.code, name: 'B' });
  assert.equal((await a.request('fishing:cast', { spotId: 'west', power: 0.5 })).error, 'NOT_PLAYING');

  a.emit('room:ready', true);
  const playing = a.next('room:state', (st) => st.phase === 'playing');
  b.emit('room:ready', true);
  await playing;
  assert.equal((await a.request('fishing:cast', { spotId: 'west', power: 0.5 })).error, 'TOO_FAR');
});

test('fishing: bite and hook reach only the caster; the rod/bobber state reaches both', async () => {
  const { a, b, created } = await startedRoom();
  place(created.room.code, 0, 'west');
  const bSees = [];
  const aSees = [];
  b.on('fishing:state', (s) => bSees.push(s.state));
  a.on('fishing:state', (s) => aSees.push(s.state));
  let bGotEvent = false;
  b.on('fishing:event', () => (bGotEvent = true));

  const res = await a.request('fishing:cast', { spotId: 'west', power: 0.5 });
  assert.equal(res.ok, true);
  assert.equal('speciesId' in res.session, false);
  const bite = await a.next('fishing:event', (e) => e.event === 'bite');
  assert.equal(bite.windowMs, 200);
  const hookedEvent = a.next('fishing:event', (e) => e.event === 'hooked'); // the event can arrive before the ack
  assert.equal((await a.request('fishing:hook', { id: res.session.id })).ok, true);
  const hooked = await hookedEvent;
  assert.ok(hooked.speciesId && Number.isInteger(hooked.seed));
  await a.request('fishing:cancel');
  await wait(100);
  assert.deepEqual(bSees, ['wait', 'bite', 'hooked', 'idle']);
  assert.deepEqual(aSees, bSees);
  assert.equal(bGotEvent, false, 'the other player must not receive the results of another line');
});

test('fishing: A missing the hook does not touch B, and both can fish at once', async () => {
  const { a, b, created } = await startedRoom();
  place(created.room.code, 0, 'west');
  place(created.room.code, 1, 'east');
  const [ra, rb] = [await a.request('fishing:cast', { spotId: 'west', power: 0.4 }), await b.request('fishing:cast', { spotId: 'east', power: 0.9 })];
  assert.ok(ra.ok && rb.ok);
  assert.notEqual(ra.session.id, rb.session.id);
  const aMiss = a.next('fishing:event', (e) => e.event === 'miss'); // A never hooks
  await b.next('fishing:event', (e) => e.event === 'bite');
  const bHooked = b.next('fishing:event', (e) => e.event === 'hooked');
  assert.equal((await b.request('fishing:hook', { id: rb.session.id })).ok, true);
  await bHooked;
  await aMiss;
  assert.equal(server.fishing.get(created.pid), null, 'A is idle again');
  assert.equal(server.fishing.active.size >= 1, true, 'B is still hooked');
  assert.equal((await a.request('fishing:cast', { spotId: 'west', power: 0.4 })).ok, true, 'A can cast again');
});

test('fishing: spamming cast over the socket keeps one session', async () => {
  const { a, created } = await startedRoom();
  place(created.room.code, 0, 'north_west');
  const results = await Promise.all(Array.from({ length: 6 }, () => a.request('fishing:cast', { spotId: 'north_west', power: 0.5 })));
  assert.equal(results.filter((r) => r.ok).length, 1);
  assert.equal(results.filter((r) => r.error === 'ALREADY_FISHING').length, 5);
});

test('fishing: early hook fails; disconnect and leave drop the line and tell the room', async () => {
  const { a, b, created } = await startedRoom();
  place(created.room.code, 0, 'west');
  const res = await a.request('fishing:cast', { spotId: 'west', power: 0.5 });
  const early = a.next('fishing:event', (e) => e.event === 'fail');
  await a.request('fishing:hook', { id: res.session.id });
  assert.equal((await early).reason, 'early');

  await a.request('fishing:cast', { spotId: 'west', power: 0.5 });
  const idle = b.next('fishing:state', (s) => s.state === 'idle' && s.pid === created.pid);
  a.disconnect();
  await idle;
  assert.equal(server.fishing.get(created.pid), null);
});

test('reeling over the wire: the client plays the fight locally, the server replays the input and confirms', async () => {
  const { a, b, created } = await startedRoom();
  place(created.room.code, 0, 'west');
  const res = await a.request('fishing:cast', { spotId: 'west', power: 0.5 });
  const hookedEvent = a.next('fishing:event', (e) => e.event === 'hooked');
  await a.next('fishing:event', (e) => e.event === 'bite');
  await a.request('fishing:hook', { id: res.session.id });
  const hooked = await hookedEvent;

  const fight = play(byId(hooked.speciesId), bots.fishWatcher(), hooked.seed, hooked.gear, hooked.weight);
  assert.equal(fight.sim.outcome, 'caught');
  skewMs += (fight.sim.tick / TICK_RATE) * 1000; // the fight took this long
  const result = a.next('fishing:event', (e) => e.event === 'result');
  const bSees = [];
  b.on('fishing:state', (st) => bSees.push(st.state));
  const ack = await a.request('fishing:finish', { id: res.session.id, toggles: fight.toggles });
  assert.deepEqual([ack.ok, ack.outcome], [true, 'caught']);
  const confirmed = await result;
  const fish = byId(hooked.speciesId);
  assert.deepEqual({ ...confirmed, weight: undefined }, { event: 'result', id: res.session.id, outcome: 'caught', speciesId: hooked.speciesId, tick: fight.sim.tick, rarity: fish.rarity, stored: true, itemId: confirmed.itemId, isNew: confirmed.isNew, record: confirmed.record, weight: undefined });
  assert.equal(confirmed.isNew, true, 'the very first catch of a species unlocks it');
  assert.equal(confirmed.record, false);
  assert.ok(Number.isInteger(confirmed.itemId), 'the catch has an id in the bag');
  assert.ok(confirmed.weight >= fish.minWeight && confirmed.weight <= fish.maxWeight);
  await wait(100);
  assert.equal(bSees.at(-1), 'idle', 'the other player sees the line go away');
  assert.equal((await a.request('fishing:finish', { id: res.session.id, toggles: fight.toggles })).error, 'NO_SESSION', 'cannot claim twice');
  assert.equal((await a.request('fishing:cast', { spotId: 'west', power: 0.5 })).ok, true, 'free to cast again');
});

test('reeling over the wire: a forged log claiming a catch is replayed and not believed', async () => {
  const { a, created } = await startedRoom();
  place(created.room.code, 0, 'west');
  const res = await a.request('fishing:cast', { spotId: 'west', power: 0.5 });
  await a.next('fishing:event', (e) => e.event === 'bite');
  const hookedEvent = a.next('fishing:event', (e) => e.event === 'hooked');
  await a.request('fishing:hook', { id: res.session.id });
  const hooked = await hookedEvent;
  skewMs += 60000;
  // "I held the button from the first tick": a masher cannot land any of these fish, whatever the client says.
  const result = a.next('fishing:event', (e) => e.event === 'result');
  const ack = await a.request('fishing:finish', { id: res.session.id, toggles: [0] });
  assert.notEqual(ack.outcome, 'caught');
  assert.notEqual((await result).outcome, 'caught');
  assert.ok(['snapped', 'escaped', 'timeout'].includes(ack.outcome), ack.outcome);
  assert.ok(hooked.speciesId);
});

test('fishing: a player who joins or rejoins mid-game is told about lines that are already out', async () => {
  const { a, b, created, joined } = await startedRoom();
  place(created.room.code, 0, 'west');
  const res = await a.request('fishing:cast', { spotId: 'west', power: 0.5 });
  assert.equal(res.ok, true);

  // B drops and reclaims the slot while A's line is in the water.
  b.disconnect();
  const b2 = await client();
  const snapshot = b2.next('fishing:state', (st) => st.pid === created.pid);
  const back = await b2.request('room:rejoin', { code: created.room.code, token: joined.token });
  assert.equal(back.ok, true);
  const s = await snapshot;
  assert.equal(s.state, 'wait');
  assert.deepEqual(s.bobber, res.session.bobber);
  assert.equal(s.facing, 'right');

  // A new player taking a freed slot gets the same snapshot.
  await b2.request('room:leave');
  const c = await client();
  const forC = c.next('fishing:state', (st) => st.pid === created.pid);
  assert.equal((await c.request('room:join', { code: created.room.code, name: 'C' })).ok, true);
  assert.equal((await forC).state, 'wait');

  // Nothing is sent about idle players, and the caster does not get a snapshot of their own line.
  const d = await client();
  const e = await d.request('room:create', { name: 'D' });
  let got = false;
  d.on('fishing:state', () => (got = true));
  const f = await client();
  await f.request('room:join', { code: e.room.code, name: 'F' });
  await wait(100);
  assert.equal(got, false);
});

// ---- Phase 5: pools, weights, catch result, rare announcement ----
async function fishAndLand(a, code, spotId, rolls, reaction = 100) {
  place(code, 0, spotId);
  rngOverride = rolls;
  const res = await a.request('fishing:cast', { spotId, power: 0.5 });
  rngOverride = null;
  assert.equal(res.ok, true);
  await a.next('fishing:event', (e) => e.event === 'bite');
  const hookedEvent = a.next('fishing:event', (e) => e.event === 'hooked');
  await a.request('fishing:hook', { id: res.session.id });
  const hooked = await hookedEvent;
  const fight = play(byId(hooked.speciesId), bots.fishWatcher(reaction), hooked.seed, hooked.gear, hooked.weight);
  skewMs += (fight.sim.tick / TICK_RATE) * 1000;
  const result = a.next('fishing:event', (e) => e.event === 'result');
  const ack = await a.request('fishing:finish', { id: res.session.id, toggles: fight.toggles });
  return { id: res.session.id, hooked, fight, ack, result: await result };
}

test('catch result: the server reports species, rarity and a weight within the species range', async () => {
  const { a, created } = await startedRoom();
  const { hooked, result } = await fishAndLand(a, created.room.code, 'north_east', scripted([0.1, 0.5, 0.5, 0.123, 0.5, 0]));
  const fish = byId(hooked.speciesId);
  assert.equal(result.outcome, 'caught');
  assert.equal(result.speciesId, fish.id);
  assert.equal(result.rarity, fish.rarity);
  assert.ok(result.weight >= fish.minWeight && result.weight <= fish.maxWeight, `${fish.id} ${result.weight}`);
  assert.ok(RARITIES.includes(result.rarity));
});

test('every cast over the wire hooks a fish from that spot\'s pool', async () => {
  const { a, created } = await startedRoom();
  const SPOTLIST = JSON.parse(readFileSync(new URL('../src/data/spots.json', import.meta.url), 'utf8'));
  for (const sp of SPOTLIST.filter((s) => !s.map || s.map === 'lake')) {
    place(created.room.code, 0, sp.id);
    const res = await a.request('fishing:cast', { spotId: sp.id, power: 0.5 });
    assert.equal(res.ok, true, sp.id);
    await a.next('fishing:event', (e) => e.event === 'bite');
    const hooked = a.next('fishing:event', (e) => e.event === 'hooked');
    await a.request('fishing:hook', { id: res.session.id });
    assert.ok(sp.pool.includes((await hooked).speciesId), `${sp.id} produced a fish outside its pool`);
    await a.request('fishing:cancel');
  }
});

test('rare announcement: the OTHER player gets it once, with name/species/weight; the catcher does not', async () => {
  const { a, b, created } = await startedRoom();
  const toB = [];
  const toA = [];
  b.on('fishing:rare', (r) => toB.push(r));
  a.on('fishing:rare', (r) => toA.push(r));
  const { id, hooked, result, fight } = await fishAndLand(a, created.room.code, 'dock_right', scripted([0.9, 0, 0.5, 0.123, 0.5, 0]));
  assert.equal(result.outcome, 'caught');
  assert.equal(result.rarity, 'rare');
  await wait(150);
  assert.equal(toB.length, 1);
  assert.deepEqual(toB[0], { pid: created.pid, name: 'Alice', id, speciesId: hooked.speciesId, rarity: 'rare', weight: result.weight });
  assert.equal(toA.length, 0, 'the catcher sees a catch card, not a toast');

  // Claiming the same fight again cannot produce a second announcement.
  assert.equal((await a.request('fishing:finish', { id, toggles: fight.toggles })).error, 'NO_SESSION');
  await wait(150);
  assert.equal(toB.length, 1, 'no duplicate announcement');
});

test('rare announcement: common catches and failed fights stay quiet', async () => {
  const { a, b, created } = await startedRoom();
  let heard = 0;
  b.on('fishing:rare', () => heard++);
  await fishAndLand(a, created.room.code, 'north_east', scripted([0.1, 0.5, 0.5, 0.123, 0.5, 0]));
  // a rare fish that is lost (held the button the whole time)
  place(created.room.code, 0, 'dock_right');
  rngOverride = scripted([0.97, 0.5, 0.5, 0.123, 0.5, 0]);
  const res = await a.request('fishing:cast', { spotId: 'dock_right', power: 0.5 });
  rngOverride = null;
  await a.next('fishing:event', (e) => e.event === 'bite');
  await a.request('fishing:hook', { id: res.session.id });
  skewMs += 60000;
  const ack = await a.request('fishing:finish', { id: res.session.id, toggles: [0] });
  assert.notEqual(ack.outcome, 'caught');
  await wait(150);
  assert.equal(heard, 0);
});

test('rare announcement: each of several rare catches is announced exactly once', async () => {
  const { a, b, created } = await startedRoom();
  const ids = [];
  b.on('fishing:rare', (r) => ids.push(r.id));
  const landed = [];
  for (const rolls of [[0.9, 0], [0.97, 0.99], [0.9, 0.5]]) {
    const r = await fishAndLand(a, created.room.code, 'dock_right', scripted([...rolls, 0.5, 0.123 + landed.length / 10, 0.5, 0]));
    assert.equal(r.result.outcome, 'caught');
    landed.push(r.id);
  }
  await wait(200);
  assert.deepEqual(ids, landed);
  assert.equal(new Set(ids).size, 3);
});

// ---- Phase 7: session stats + emotes ----
test('session stats: caught, biggest and rare count are tracked per player and broadcast to the room', async () => {
  const { a, b, created } = await startedRoom();
  const seen = [];
  b.on('room:state', (st) => seen.push(st));
  const first = await fishAndLand(a, created.room.code, 'north_east', scripted([0.1, 0.5, 0.5, 0.123, 0.5, 0]));
  const rare = await fishAndLand(a, created.room.code, 'dock_right', scripted([0.9, 0, 0.5, 0.2, 0.5, 0]));
  await wait(150);
  const mine = server.rooms.rooms.get(created.room.code).players.find((p) => p.pid === created.pid);
  assert.deepEqual([mine.stats.caught, mine.stats.rare], [2, 1]);
  assert.equal(mine.stats.biggest, Math.max(first.result.weight, rare.result.weight));
  const last = seen.at(-1).players.find((p) => p.pid === created.pid);
  assert.deepEqual(last.stats, mine.stats, 'the other player was told');
  const partner = seen.at(-1).players.find((p) => p.pid !== created.pid);
  assert.deepEqual(partner.stats, { caught: 0, biggest: 0, rare: 0, rescues: 0 });
});

test('session stats: a lost fight changes nothing; they survive a reconnect', async () => {
  const { a, created } = await startedRoom();
  place(created.room.code, 0, 'dock_right');
  rngOverride = scripted([0.97, 0.5, 0.5, 0.123, 0.5, 0]);
  const res = await a.request('fishing:cast', { spotId: 'dock_right', power: 0.5 });
  rngOverride = null;
  await a.next('fishing:event', (e) => e.event === 'bite');
  await a.request('fishing:hook', { id: res.session.id });
  skewMs += 60000;
  await a.request('fishing:finish', { id: res.session.id, toggles: [0] });
  const p = server.rooms.rooms.get(created.room.code).players.find((x) => x.pid === created.pid);
  assert.deepEqual(p.stats, { caught: 0, biggest: 0, rare: 0, rescues: 0 });
  p.stats.caught = 3;
  a.disconnect();
  const again = await client();
  const back = await again.request('room:rejoin', { code: created.room.code, token: created.token });
  assert.equal(back.room.players.find((x) => x.pid === created.pid).stats.caught, 3);
});

test('emotes: relayed to the other player only, validated, and flood-limited', async () => {
  const { a, b, created } = await startedRoom();
  const toB = [];
  const toA = [];
  b.on('emote', (e) => toB.push(e));
  a.on('emote', (e) => toA.push(e));
  a.emit('emote', { id: 2 });
  await wait(100);
  assert.deepEqual(toB, [{ pid: created.pid, id: 2 }]);
  assert.equal(toA.length, 0, 'the sender draws their own bubble');

  for (const bad of [{ id: -1 }, { id: 4 }, { id: 1.5 }, { id: '1' }, {}, null, undefined]) a.emit('emote', bad);
  await wait(900); // let the rate limit window pass between the valid ones below
  for (let i = 0; i < 10; i++) a.emit('emote', { id: 1 }); // a burst
  await wait(150);
  assert.equal(toB.length, 2, 'invalid ids dropped; a burst yields a single emote');
  await wait(850);
  a.emit('emote', { id: 3 });
  await wait(100);
  assert.deepEqual(toB.at(-1), { pid: created.pid, id: 3 }, 'allowed again after the gap');
});

test('emotes only work in a running game', async () => {
  const [a, b] = [await client(), await client()];
  const { room } = await a.request('room:create', { name: 'A' });
  await b.request('room:join', { code: room.code, name: 'B' });
  let got = false;
  b.on('emote', () => (got = true));
  a.emit('emote', { id: 0 });
  await wait(100);
  assert.equal(got, false, 'nothing from the lobby');
});
