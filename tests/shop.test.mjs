import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { io as connect } from 'socket.io-client';
import { createGameServer } from '../server/index.js';
import FishingSessions from '../src/systems/FishingSessions.js';
import { reelParams, replay, TICK_RATE } from '../src/systems/ReelSim.js';
import { SHOP } from '../src/data/world.js';
import { FISHING } from '../src/systems/FishingRules.js';
import Economy, { INVENTORY_SLOTS, DEFAULT_GEAR, DEFAULT_OWNED, salePrice } from '../src/systems/Economy.js';
import MemoryStore from '../src/systems/MemoryStore.js';
import { play, bots, byId, behaviours, species, catchRate } from './bots.mjs';

const readJson = (rel) => JSON.parse(readFileSync(new URL(rel, import.meta.url), 'utf8'));
const spots = readJson('../src/data/spots.json');
const equipment = readJson('../src/data/equipment.json');
const eq = (id) => equipment.find((e) => e.id === id);

let server;
let skewMs = 0;
let rngOverride = null;
let streamSeed = 31337;
const stream = () => ((streamSeed = (streamSeed * 1664525 + 1013904223) % 4294967296) / 4294967296);
const scripted = (values) => { let i = 0; return () => (i < values.length ? values[i++] : stream()); };
const clients = [];
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

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

async function client(url = `http://localhost:${server.port}`) {
  const s = connect(url, { transports: ['websocket'], forceNew: true });
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

/** A player in a running room with a profile; returns helpers to move around and fish. */
async function player(name = 'Ann', hello = {}) {
  const a = await client();
  const h = await a.request('profile:hello', { name, ...hello });
  const b = await client();
  await b.request('profile:hello', { name: 'Partner' });
  const created = await a.request('room:create', { name });
  await b.request('room:join', { code: created.room.code, name: 'Partner' });
  const playing = a.next('room:state', (s) => s.phase === 'playing');
  a.emit('room:ready', true);
  b.emit('room:ready', true);
  await playing;
  const me = () => server.rooms.rooms.get(created.room.code).players.find((p) => p.pid === created.pid);
  const goto = (x, y) => { me().x = x; me().y = y; };
  const atShop = () => goto(SHOP.talkX, SHOP.talkY);
  const atSpot = (id) => goto(spots.find((s) => s.id === id).x, spots.find((s) => s.id === id).y);
  const state = () => server.economy.state(h.profile.id);
  return { a, b, h, created, me, goto, atShop, atSpot, state, profileId: h.profile.id };
}

/** Cast, hook and win a fight with the given rolls; resolves with the confirmed result. */
async function land(p, spotId, rolls, bot = bots.fishWatcher(100)) {
  p.atSpot(spotId);
  rngOverride = scripted(rolls);
  const res = await p.a.request('fishing:cast', { spotId, power: 0.5 });
  rngOverride = null;
  if (!res.ok) return { cast: res };
  await p.a.next('fishing:event', (e) => e.event === 'bite');
  const hookedEvent = p.a.next('fishing:event', (e) => e.event === 'hooked');
  await p.a.request('fishing:hook', { id: res.session.id });
  const hooked = await hookedEvent;
  const fight = play(byId(hooked.speciesId), bot, hooked.seed, hooked.gear, hooked.weight);
  skewMs += (fight.sim.tick / TICK_RATE) * 1000;
  const result = p.a.next('fishing:event', (e) => e.event === 'result');
  const ack = await p.a.request('fishing:finish', { id: res.session.id, toggles: fight.toggles });
  return { cast: res, hooked, fight, ack, result: await result };
}
const common = [0.1, 0.5, 0.5, 0.123, 0.5, 0]; // a common fish from north_east, bite 3s

// ---------------- profiles ----------------

test('hello: a new player gets a profile + token, coming back with it restores the same profile', async () => {
  const c1 = await client();
  const first = await c1.request('profile:hello', { name: 'Zed', tab: 't1' });
  assert.equal(first.ok, true);
  assert.ok(first.profile.id && first.profile.token);
  assert.equal(first.profile.fresh, false);
  assert.deepEqual([first.state.coin, first.state.items.length], [0, 0]);
  assert.deepEqual(first.state.equipped, DEFAULT_GEAR);
  server.economy.store.saveProfile({ ...server.store.getProfile(first.profile.id), coin: 77 });

  c1.disconnect();
  await wait(50);
  const c2 = await client();
  const again = await c2.request('profile:hello', { id: first.profile.id, token: first.profile.token, tab: 't1' });
  assert.equal(again.profile.id, first.profile.id);
  assert.equal('token' in again.profile, false, 'the token is only ever sent once');
  assert.equal(again.state.coin, 77);
});

test('hello: a wrong token never gives access; it just creates a separate empty profile', async () => {
  const c1 = await client();
  const owner = await c1.request('profile:hello', { name: 'Owner' });
  server.store.saveProfile({ ...server.store.getProfile(owner.profile.id), coin: 500 });
  const thief = await client();
  const res = await thief.request('profile:hello', { id: owner.profile.id, token: 'guess', name: 'Thief' });
  assert.notEqual(res.profile.id, owner.profile.id);
  assert.equal(res.state.coin, 0);
  assert.equal((await thief.request('profile:hello', { id: owner.profile.id, name: 'NoToken' })).profile.id === owner.profile.id, false);
});

test('hello: a second tab of the same browser gets its own profile; a reload of the same tab keeps it', async () => {
  const tab1 = await client();
  const mine = await tab1.request('profile:hello', { name: 'Me', tab: 'A' });

  const tab2 = await client();
  const second = await tab2.request('profile:hello', { id: mine.profile.id, token: mine.profile.token, tab: 'B', name: 'Me2' });
  assert.notEqual(second.profile.id, mine.profile.id);
  assert.equal(second.profile.fresh, true);
  assert.ok(second.profile.token, 'the fresh profile comes with its own token');

  const reload = await client(); // same tab id, old socket still connected
  const same = await reload.request('profile:hello', { id: mine.profile.id, token: mine.profile.token, tab: 'A' });
  assert.equal(same.profile.id, mine.profile.id);
  assert.equal(same.profile.fresh, false);
  await wait(100);
  assert.equal(tab1.connected, false, 'the stale socket of the reloaded tab was dropped');
});

test('rooms still work for a client that never said hello (it gets a guest profile)', async () => {
  const a = await client();
  const created = await a.request('room:create', { name: 'Guest' });
  assert.equal(created.ok, true);
  assert.ok((await a.request('inv:get')).state);
});

// ---------------- catching into the bag ----------------

test('a landed fish goes into the bag with the server\'s weight and species; the client is told', async () => {
  const p = await player('Fisher');
  const pushed = p.a.next('inv:state', (s) => s.items.length === 1);
  const r = await land(p, 'north_east', common);
  assert.equal(r.result.outcome, 'caught');
  assert.equal(r.result.stored, true);
  const state = await pushed;
  assert.equal(state.items[0].id, r.result.itemId);
  assert.equal(state.items[0].speciesId, r.result.speciesId);
  assert.equal(state.items[0].weight, r.result.weight);
  assert.equal(state.items[0].price, salePrice(byId(r.result.speciesId), r.result.weight));
});

test('a lost fight puts nothing in the bag', async () => {
  const p = await player('Loser');
  p.atSpot('north_east');
  rngOverride = scripted(common);
  const res = await p.a.request('fishing:cast', { spotId: 'north_east', power: 0.5 });
  rngOverride = null;
  await p.a.next('fishing:event', (e) => e.event === 'bite');
  await p.a.request('fishing:hook', { id: res.session.id });
  skewMs += 60000;
  const ack = await p.a.request('fishing:finish', { id: res.session.id, toggles: [0] });
  assert.notEqual(ack.outcome, 'caught');
  assert.equal(p.state().items.length, 0);
});

test('a full bag stops you casting (before you waste a fight); selling frees a slot', async () => {
  const p = await player('Hoarder');
  for (let i = 0; i < INVENTORY_SLOTS; i++) server.economy.addCatch(p.profileId, { speciesId: 'minnow', weight: 0.1 });
  p.atSpot('north_east');
  const blocked = await p.a.request('fishing:cast', { spotId: 'north_east', power: 0.5 });
  assert.deepEqual([blocked.ok, blocked.error], [false, 'INVENTORY_FULL']);
  assert.equal(server.fishing.get(p.created.pid), null, 'no session was started');

  p.atShop();
  assert.equal((await p.a.request('inv:sell', { ids: [p.state().items[0].id] })).ok, true);
  const r = await land(p, 'north_east', common);
  assert.equal(r.result.outcome, 'caught');
  assert.equal(p.state().items.length, INVENTORY_SLOTS);
});

// ---------------- selling ----------------

test('selling only works at the stall; there it pays exactly the sale price and updates the client', async () => {
  const p = await player('Seller');
  const f1 = server.economy.addCatch(p.profileId, { speciesId: 'carp', weight: 4 }).item;
  const f2 = server.economy.addCatch(p.profileId, { speciesId: 'trout', weight: 2 }).item;

  p.goto(200, 91); // by the lake
  const away = await p.a.request('inv:sell', { ids: [f1.id] });
  assert.deepEqual([away.ok, away.error], [false, 'NOT_AT_SHOP']);
  assert.equal((await p.a.request('inv:sellAll')).error, 'NOT_AT_SHOP');
  assert.equal(p.state().coin, 0);

  p.atShop();
  const pushed = p.a.next('inv:state', (s) => s.coin > 0);
  const sold = await p.a.request('inv:sell', { ids: [f1.id] });
  assert.deepEqual([sold.ok, sold.earned], [true, 48]);
  assert.equal(sold.state.coin, 48);
  assert.deepEqual((await pushed).items.map((i) => i.id), [f2.id]);
  assert.equal(p.state().coin, 48);
});

test('selling twice, in a flood of requests, still pays once', async () => {
  const p = await player('Flood');
  const f = server.economy.addCatch(p.profileId, { speciesId: 'carp', weight: 5 }).item;
  p.atShop();
  const results = await Promise.all(Array.from({ length: 8 }, () => p.a.request('inv:sell', { ids: [f.id, f.id] })));
  assert.equal(results.filter((r) => r.ok).length, 1);
  assert.equal(results.filter((r) => r.error === 'NOT_FOUND').length, 7);
  assert.equal(p.state().coin, 60);
});

test('sell all and malformed requests', async () => {
  const p = await player('All');
  const items = [['carp', 2], ['minnow', 0.1], ['koi', 3]].map(([s, w]) => server.economy.addCatch(p.profileId, { speciesId: s, weight: w }).item);
  p.atShop();
  for (const bad of [undefined, null, 'x', [], [1.5], [-1], { length: 3 }]) {
    const r = await p.a.request('inv:sell', { ids: bad });
    assert.equal(r.ok, false);
  }
  assert.equal(p.state().coin, 0);
  const all = await p.a.request('inv:sellAll');
  assert.equal(all.earned, items.reduce((s, i) => s + salePrice(byId(i.speciesId), i.weight), 0));
  assert.equal((await p.a.request('inv:sellAll')).error, 'NOTHING_TO_SELL');
});

test('nobody can sell another player\'s fish', async () => {
  const mine = await player('Mine');
  const theirs = await player('Theirs');
  const f = server.economy.addCatch(theirs.profileId, { speciesId: 'carp', weight: 5 }).item;
  mine.atShop();
  const r = await mine.a.request('inv:sell', { ids: [f.id] });
  assert.equal(r.error, 'NOT_FOUND');
  assert.equal(theirs.state().items.length, 1);
  assert.equal(mine.state().coin, 0);
});

// ---------------- shop & gear ----------------

test('buying: needs the stall and enough coin, never goes negative, cannot be bought twice', async () => {
  const p = await player('Buyer');
  p.atShop();
  let r = await p.a.request('shop:buy', { id: 'rod_fiber' });
  assert.deepEqual([r.ok, r.error], [false, 'NOT_ENOUGH_COIN']);
  server.store.saveProfile({ ...server.store.getProfile(p.profileId), coin: 350 });
  p.goto(200, 91);
  assert.equal((await p.a.request('shop:buy', { id: 'rod_fiber' })).error, 'NOT_AT_SHOP');
  p.atShop();
  r = await p.a.request('shop:buy', { id: 'rod_fiber' });
  assert.equal(r.ok, true);
  assert.equal(r.state.coin, 50);
  assert.ok(r.state.owned.includes('rod_fiber'));
  assert.equal((await p.a.request('shop:buy', { id: 'rod_fiber' })).error, 'ALREADY_OWNED');
  assert.equal((await p.a.request('shop:buy', { id: 'line_titanium' })).error, 'NOT_ENOUGH_COIN');
  assert.equal(p.state().coin, 50);
  assert.equal((await p.a.request('shop:buy', { id: 'does_not_exist' })).error, 'NOT_FOUND');
});

test('equipping: only what you own; works anywhere; not in the middle of a fight', async () => {
  const p = await player('Equipper');
  p.goto(200, 91);
  assert.equal((await p.a.request('shop:equip', { id: 'rod_carbon' })).error, 'NOT_OWNED');
  server.store.saveProfile({ ...server.store.getProfile(p.profileId), coin: 5000 });
  p.atShop();
  for (const id of ['rod_carbon', 'line_titanium']) assert.equal((await p.a.request('shop:buy', { id })).ok, true);
  p.goto(200, 91);
  const eqd = await p.a.request('shop:equip', { id: 'rod_carbon' });
  assert.equal(eqd.ok, true);
  assert.equal(eqd.state.equipped.rod, 'rod_carbon');

  p.atSpot('north_east');
  rngOverride = scripted(common);
  const cast = await p.a.request('fishing:cast', { spotId: 'north_east', power: 0.5 });
  rngOverride = null;
  assert.equal((await p.a.request('shop:equip', { id: 'line_titanium' })).error, 'BUSY', 'gear is locked while a line is out');
  assert.equal(p.state().equipped.line, 'line_basic');
  await p.a.request('fishing:cancel');
  assert.equal((await p.a.request('shop:equip', { id: 'line_titanium' })).ok, true);
  assert.ok(cast.ok);
});

// ---------------- gear really changes the game ----------------

test('the fight is played with the gear equipped when the line was cast, and the server replays with it', async () => {
  const p = await player('Geared');
  server.store.saveProfile({ ...server.store.getProfile(p.profileId), coin: 5000 });
  p.atShop();
  for (const id of ['rod_carbon', 'line_titanium', 'bait_golden']) await p.a.request('shop:buy', { id });
  for (const id of ['rod_carbon', 'line_titanium', 'bait_golden']) await p.a.request('shop:equip', { id });
  const r = await land(p, 'dock_tip', [0.5, 0.5, 0.5, 0.123, 0.5, 0]);
  assert.deepEqual(r.hooked.gear, { reelPower: 23, lineStrength: 1.6, maxWeight: 60 });
  assert.equal(r.result.outcome, 'caught', 'the server\'s replay used the same gear as the client');
});

test('the same recorded fight is judged differently on different gear: the server cannot be fed the wrong gear', () => {
  // Find a hard fish/seed that a carbon rod + titanium line can land but starter gear cannot (with the same input).
  const trout = byId('trout');
  const strong = { reelPower: 23, lineStrength: 1.6, maxWeight: 60 };
  const basic = { reelPower: 14, lineStrength: 1, maxWeight: 6 };
  let found = null;
  for (let seed = 1; seed < 400 && !found; seed++) {
    const good = play(trout, bots.tensionWatcher(78), seed, strong, 3);
    if (good.sim.outcome !== 'caught') continue;
    const withBasic = replay(reelParams(trout, behaviours, basic, 3), seed, good.toggles);
    if (withBasic.outcome !== 'caught') found = { seed, toggles: good.toggles };
  }
  assert.ok(found, 'such a fight exists');

  const make = (gear) => {
    let now = 0;
    const events = [];
    const sessions = new FishingSessions({
      spots, species, behaviours, now: () => now,
      emit: (pid, event, payload) => events.push({ event, ...payload }),
      rng: scripted([0.9, 0.0, 0, (found.seed + 0.5) / 4294967296, 0.5, 0]),
      hooks: { gear: () => ({ rod: { reelPower: gear.reelPower }, line: { tensionBonus: gear.lineStrength - 1, maxWeight: gear.maxWeight }, bait: eq('bait_worm') }), beforeCast: () => null },
      setTimer: (fn) => { fn.__t = true; return fn; }, clearTimer: () => {},
    });
    return { sessions, events, setNow: (t) => (now = t) };
  };
  const outcomeWith = (gear) => {
    const { sessions, events, setNow } = make(gear);
    const spot = spots.find((s) => s.id === 'dock_tip'); // rare pool here starts with the trout
    const res = sessions.cast('a', { spotId: 'dock_tip', power: 0.5, x: spot.x, y: spot.y });
    const s = sessions.get('a');
    sessions.bite(s);
    sessions.hook('a', res.session.id);
    // the scripted roll gave trout? only meaningful if so
    assert.equal(s.speciesId, 'trout');
    s.weight = 3;
    setNow(120000);
    sessions.finish('a', res.session.id, found.toggles);
    return events.find((e) => e.event === 'result').outcome;
  };
  assert.equal(outcomeWith(strong), 'caught');
  assert.notEqual(outcomeWith(basic), 'caught');
});

test('better rod = shorter, easier fights', () => {
  const sp = byId('perch');
  const slow = (reelPower) => {
    let t = 0;
    let caught = 0;
    for (let i = 1; i <= 200; i++) {
      const { sim } = play(sp, bots.fishWatcher(450), i * 17, { reelPower, lineStrength: 1 });
      t += sim.time;
      if (sim.outcome === 'caught') caught++;
    }
    return { time: t / 200, rate: caught / 200 };
  };
  const [basic, fiber, carbon] = [14, 18, 23].map(slow);
  assert.ok(carbon.time < fiber.time && fiber.time < basic.time, JSON.stringify({ basic, fiber, carbon }));
  assert.ok(carbon.rate >= fiber.rate && fiber.rate >= basic.rate);
});

test('line: a fish heavier than the line is rated for is much harder; a stronger line fixes it', () => {
  const koi = byId('koi');
  const heavy = 12; // koi max weight
  const rate = (gear) => {
    let c = 0;
    for (let i = 1; i <= 300; i++) if (play(koi, bots.fishWatcher(200), i * 11, gear, heavy).sim.outcome === 'caught') c++;
    return c / 300;
  };
  const basic = rate({ reelPower: 14, lineStrength: 1, maxWeight: 6 });
  const titanium = rate({ reelPower: 14, lineStrength: 1.6, maxWeight: 60 });
  const braided = rate({ reelPower: 14, lineStrength: 1.25, maxWeight: 15 });
  assert.ok(titanium >= 0.95, `titanium ${titanium}`);
  assert.ok(basic < titanium - 0.2, `basic ${basic} vs titanium ${titanium}`);
  assert.ok(basic <= braided && braided <= titanium + 0.001);
  // and it is flagged so the UI can warn
  assert.equal(reelParams(koi, behaviours, { maxWeight: 6 }, heavy).overweight, true);
  assert.equal(reelParams(koi, behaviours, { maxWeight: 60 }, heavy).overweight, false);
  assert.equal(reelParams(koi, behaviours, { maxWeight: 6 }, 2).overweight, false, 'a small koi is fine on a cotton line');
});

test('line: the overweight penalty is capped and only affects tension, never the weight of small fish', () => {
  const trout = byId('trout');
  const base = reelParams(trout, behaviours, { maxWeight: 6 }, 1);
  const huge = reelParams(trout, behaviours, { maxWeight: 6 }, 9999);
  assert.ok(Math.abs(huge.baseRise / base.baseRise - 2.5) < 1e-9, 'capped at 2.5x');
  assert.equal(huge.pullDrift, base.pullDrift);
  assert.equal(reelParams(trout, behaviours, undefined, 50).baseRise, base.baseRise, 'no line rating = no penalty');
});

test('default gear is enough for every common fish, even at its heaviest', () => {
  const basic = { reelPower: 14, lineStrength: 1, maxWeight: 6 };
  for (const f of species.filter((s) => s.rarity === 'common')) {
    let c = 0;
    for (let i = 1; i <= 200; i++) if (play(f, bots.fishWatcher(200), i * 7, basic, f.maxWeight).sim.outcome === 'caught') c++;
    assert.ok(c / 200 >= 0.95, `${f.id} at ${f.maxWeight} kg: ${c / 200}`);
  }
});

test('bait: better lures shift the odds toward rare fish (and the starter bait changes nothing)', () => {
  const sessions = new FishingSessions({ spots, species, behaviours, rng: (() => { let s = 5; return () => ((s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296); })() });
  const tip = spots.find((s) => s.id === 'dock_tip');
  const odds = (bait) => {
    const out = { common: 0, rare: 0, epic: 0, legendary: 0 };
    for (let i = 0; i < 30000; i++) out[byId(sessions.rollCatch(tip, bait?.rarityModifier).speciesId).rarity]++;
    return Object.fromEntries(Object.entries(out).map(([k, v]) => [k, v / 30000]));
  };
  const none = odds(null);
  const worm = odds(eq('bait_worm'));
  const glow = odds(eq('bait_glow'));
  const golden = odds(eq('bait_golden'));
  for (const r of Object.keys(none)) assert.ok(Math.abs(none[r] - worm[r]) < 0.012, `${r}: starter bait should not change anything`);
  assert.ok(glow.rare > none.rare + 0.05 && glow.common < none.common);
  assert.ok(golden.legendary > none.legendary * 2.5, `legendary ${none.legendary} -> ${golden.legendary}`);
  assert.ok(golden.epic > glow.epic && golden.rare > none.rare && golden.common < glow.common);
  assert.ok(Math.abs(Object.values(golden).reduce((a, b) => a + b, 0) - 1) < 1e-9);
});

test('equipment data: stats are consistent and each tier is strictly better (and costs more)', () => {
  const tiers = (type, stat) => equipment.filter((e) => e.type === type).sort((a, b) => a.price - b.price);
  for (const type of ['rod', 'line', 'bait']) assert.equal(tiers(type).length, 3, `3 ${type}s`);
  assert.deepEqual(tiers('rod').map((r) => r.reelPower), [14, 18, 23]);
  const lines = tiers('line');
  assert.ok(lines[0].tensionBonus < lines[1].tensionBonus && lines[1].tensionBonus < lines[2].tensionBonus);
  assert.ok(lines[0].maxWeight < lines[1].maxWeight && lines[1].maxWeight < lines[2].maxWeight);
  assert.deepEqual(DEFAULT_OWNED.map((id) => eq(id).price), [0, 0, 0], 'starter gear is free');
  for (const e of equipment) assert.ok(e.price >= 0 && e.name);
  for (const t of ['rod', 'line', 'bait']) assert.equal(tiers(t)[0].price, 0, `the cheapest ${t} is the free default`);
  assert.equal(eq('rod_basic').reelPower, 14, 'the starter rod matches the reel simulation default');
});

test('economy balance: a good day of fishing buys real upgrades, but not everything at once', () => {
  const avgSale = (rarity) => {
    const group = species.filter((s) => s.rarity === rarity);
    return group.reduce((sum, s) => sum + salePrice(s, (s.minWeight + s.maxWeight) / 2.5), 0) / group.length;
  };
  const common = avgSale('common');
  const rare = avgSale('rare');
  assert.ok(common >= 5 && common < 80, `common ${common}`);
  assert.ok(rare > common * 2, 'rare fish pay clearly more');
  assert.ok(avgSale('epic') > rare && avgSale('legendary') > avgSale('epic'));
  // first upgrade is a few catches away, the whole shop is a long way off
  assert.ok(eq('line_braided').price / common < 25);
  const everything = equipment.reduce((s, e) => s + e.price, 0);
  assert.ok(everything / common > 100);
});

// ---------------- persistence across server restarts ----------------

test('coins, fish and gear survive a server restart; the same token gets the same profile back', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'ft-srv-'));
  const dbFile = path.join(dir, 'game.sqlite');
  try {
    let srv = await createGameServer({ port: 0, world: false, dbFile });
    const url = () => `http://localhost:${srv.port}`;
    const c1 = await client(url());
    const hello = await c1.request('profile:hello', { name: 'Saver', tab: 'x' });
    const id = hello.profile.id;
    srv.economy.addCatch(id, { speciesId: 'carp', weight: 5 });
    srv.economy.addCatch(id, { speciesId: 'trout', weight: 2 });
    const [carp] = srv.economy.state(id).items;
    srv.rooms; // (room not needed: sell/buy position check is covered above; use the economy directly here)
    srv.economy.sell(id, [carp.id]);
    srv.store.saveProfile({ ...srv.store.getProfile(id), coin: srv.store.getProfile(id).coin + 300 });
    srv.economy.buy(id, 'rod_fiber');
    srv.economy.equip(id, 'rod_fiber');
    const before = srv.economy.state(id);
    c1.disconnect();
    await srv.close();

    srv = await createGameServer({ port: 0, world: false, dbFile });
    const c2 = await client(url());
    const back = await c2.request('profile:hello', { id, token: hello.profile.token, tab: 'x' });
    assert.equal(back.profile.id, id);
    assert.deepEqual(back.state, before);
    assert.equal(back.state.equipped.rod, 'rod_fiber');
    assert.equal(back.state.items.length, 1);
    assert.equal(back.state.coin, before.coin);
    c2.disconnect();
    await srv.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
