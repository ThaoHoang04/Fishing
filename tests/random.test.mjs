import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { io as connect } from 'socket.io-client';
import { createGameServer } from '../server/index.js';
import { Seagulls, Chests } from '../server/randomEvents.js';
import FishingSessions from '../src/systems/FishingSessions.js';
import Economy from '../src/systems/Economy.js';
import MemoryStore from '../src/systems/MemoryStore.js';
import { createWorld } from '../src/systems/World.js';
import { play, bots, byId as fishById } from './bots.mjs';
import { TICK_RATE } from '../src/systems/ReelSim.js';

const readJson = (rel) => JSON.parse(readFileSync(new URL(rel, import.meta.url), 'utf8'));
const FISH = readJson('../src/data/fish.json');
const TRASH = readJson('../src/data/trash.json');
const BEHAVIOURS = readJson('../src/data/behaviours.json');
const SPOTS = readJson('../src/data/spots.json');
const EQUIPMENT = readJson('../src/data/equipment.json');
const CONDITIONS = readJson('../src/data/conditions.json');
const EVENTS = readJson('../src/data/events.json');
const RANDOM = readJson('../src/data/randomEvents.json');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const mulberry = (a) => () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };

// ---------------- data ----------------

test('junk data: unique ids, real behaviours, real icons, one chest, nothing that looks like a FishDex species', () => {
  const ids = new Set(FISH.map((f) => f.id));
  assert.equal(new Set(TRASH.map((t) => t.id)).size, TRASH.length);
  for (const t of TRASH) {
    assert.ok(!ids.has(t.id), `${t.id} clashes with a fish`);
    assert.ok(t.trash === true && BEHAVIOURS[t.behaviour], t.id);
    assert.ok(t.difficulty > 0 && t.difficulty <= 1, `${t.id} is easy to land`);
    assert.ok(t.minWeight > 0 && t.maxWeight >= t.minWeight && t.basePrice >= 0 && Number.isInteger(t.icon) && t.icon >= 0 && t.icon < 132, t.id);
    assert.equal(t.rarity, 'common');
  }
  assert.equal(TRASH.filter((t) => t.chest).length, 1);
  assert.ok(TRASH.filter((t) => !t.chest && t.basePrice * t.maxWeight < 200).length >= 6, 'most junk is nearly worthless');
});

// ---------------- the roll ----------------

const sessions = (config, rng) => new FishingSessions({ spots: SPOTS, species: FISH, trash: TRASH, behaviours: BEHAVIOURS, config, rng });

test('off by default: no junk and not one extra random number is drawn (so scripted rolls elsewhere stay exact)', () => {
  let draws = 0;
  const s = sessions({}, () => { draws++; return 0.5; });
  assert.equal(s.rollSpecial(), null);
  assert.equal(draws, 0);
});

test('junk and chests: one roll decides, the chest comes first, junk can be dressed up as a legendary, chests never', () => {
  const s = sessions({ CHEST_CHANCE: 0.1, TRASH_CHANCE: 0.3, FAKE_CHANCE: 0.5 }, mulberry(5));
  const seen = { chest: 0, junk: 0, none: 0, fake: 0 };
  for (let i = 0; i < 4000; i++) {
    const r = s.rollSpecial();
    if (!r) seen.none++;
    else if (s.speciesById.get(r.speciesId).chest) { seen.chest++; assert.equal(r.fake, undefined); } else { seen.junk++; if (r.fake) seen.fake++; }
    if (r) {
      const sp = s.speciesById.get(r.speciesId);
      assert.ok(r.weight >= sp.minWeight && r.weight <= sp.maxWeight);
    }
  }
  assert.ok(Math.abs(seen.chest / 4000 - 0.1) < 0.025, `chests ${seen.chest}`);
  assert.ok(Math.abs(seen.junk / 4000 - 0.3) < 0.03, `junk ${seen.junk}`);
  assert.ok(Math.abs(seen.fake / seen.junk - 0.5) < 0.06, 'half of the junk is fake legendary');
  assert.ok(seen.none > 2000);
  // fixed fakes
  const always = sessions({ TRASH_CHANCE: 1, FAKE_CHANCE: 1 }, mulberry(1));
  assert.ok(Array.from({ length: 50 }, () => always.rollSpecial()).every((r) => r.fake === true));
  const never = sessions({ TRASH_CHANCE: 1, FAKE_CHANCE: 0 }, mulberry(1));
  assert.ok(Array.from({ length: 50 }, () => never.rollSpecial()).every((r) => r.fake === undefined));
});

test('a cast can bring up junk, and the hooked event carries the disguise; a real catch of it needs the usual fight', () => {
  const events = [];
  const s = new FishingSessions({
    spots: SPOTS, species: FISH, trash: TRASH, behaviours: BEHAVIOURS, rng: mulberry(9), now: () => 0,
    setTimer: () => 1, clearTimer: () => {}, emit: (pid, event, payload) => events.push([event, payload]),
    config: { TRASH_CHANCE: 1, FAKE_CHANCE: 1 },
  });
  const west = SPOTS.find((x) => x.id === 'west');
  const cast = s.cast('p', { spotId: 'west', power: 0.5, x: west.x, y: west.y });
  assert.equal(cast.ok, true);
  const session = s.get('p');
  assert.ok(TRASH.some((t) => t.id === session.speciesId && !t.chest));
  assert.equal(session.fake, true);
  session.state = 'bite'; // (bite() is what flips it after the delay; drive it by hand)
  s.hook('p', cast.session.id);
  const hooked = events.find(([e]) => e === 'hooked');
  assert.equal(hooked[1].fake, true);
  assert.equal(hooked[1].speciesId, session.speciesId);
});

// ---------------- the lucky spot ----------------

const lakeSpots = SPOTS.filter((s) => s.type !== 'zone' && (s.map ?? 'lake') === 'lake').map((s) => s.id);
const lucky = { ...RANDOM.lucky, spots: lakeSpots };
const sky = createWorld({ conditions: CONDITIONS, events: EVENTS, lucky });

test('the lucky spot is a pure function of the clock and seed: one glowing spot per slot, for a minute, on the lake only', () => {
  const step = 5000;
  for (const seed of [1, 77, 4242]) {
    let activeMs = 0;
    let spans = 0;
    let prev = null;
    for (let t = 0; t < RANDOM.lucky.slotMs * 12; t += step) {
      const a = sky.state(t, { seed, mapId: 'lake' }).lucky;
      assert.deepEqual(a, sky.state(t, { seed, mapId: 'lake' }).lucky, 'deterministic');
      assert.equal(sky.state(t, { seed, mapId: 'ocean' }).lucky, null, 'not at sea');
      if (a) {
        activeMs += step;
        assert.ok(lakeSpots.includes(a.spotId));
        assert.ok(a.until > t && a.until - t <= RANDOM.lucky.lifeMs);
        if (!prev || prev.until !== a.until) spans++;
      }
      prev = a;
    }
    assert.equal(spans, 12, `seed ${seed}: one a slot`);
    assert.ok(Math.abs(activeMs - 12 * RANDOM.lucky.lifeMs) <= 12 * step, `seed ${seed}: ${activeMs}ms`);
  }
  assert.equal(createWorld({ conditions: CONDITIONS, events: EVENTS }).state(1000, { seed: 1 }).lucky, null, 'off unless configured');
});

test('fishing at the glowing spot favours rare, epic and legendary fish; elsewhere nothing changes', () => {
  const west = SPOTS.find((x) => x.id === 'west');
  const count = (world) => {
    let better = 0;
    for (let seed = 1; seed <= 1500; seed++) {
      const s = new FishingSessions({
        spots: SPOTS, species: FISH, trash: TRASH, behaviours: BEHAVIOURS, rng: mulberry(seed), now: () => 0, setTimer: () => 1, clearTimer: () => {},
        hooks: { conditions: () => world },
      });
      s.cast('p', { spotId: 'west', power: 0.5, x: west.x, y: west.y, mapId: 'lake' });
      if (fishById(s.get('p').speciesId).rarity !== 'common') better++;
    }
    return better;
  };
  const base = { time: 'day', weather: 'clear', events: [], modifiers: { rarityModifier: { common: 1, rare: 1, epic: 1, legendary: 1 }, biteSpeed: 1 } };
  const plain = count({ ...base, lucky: null });
  const glowing = count({ ...base, lucky: { spotId: 'west', until: 1, rarityModifier: RANDOM.lucky.rarityModifier } });
  const elsewhere = count({ ...base, lucky: { spotId: 'east', until: 1, rarityModifier: RANDOM.lucky.rarityModifier } });
  assert.ok(glowing > plain * 1.4, `${glowing} vs ${plain}`);
  assert.equal(elsewhere, plain, 'another spot glowing changes nothing here');
});

// ---------------- economy ----------------

function economy() {
  const store = new MemoryStore();
  const eco = new Economy({ store, species: [...FISH, ...TRASH], equipment: EQUIPMENT });
  store.createProfile({ id: 'a', tokenHash: 'a', name: 'a', coin: 5, owned: ['rod_basic', 'line_basic', 'bait_worm'], equipped: { rod: 'rod_basic', line: 'line_basic', bait: 'bait_worm' }, createdAt: 0 });
  return eco;
}

test('Economy.grant pays a prize, Economy.discard drops a fish without paying', () => {
  const eco = economy();
  assert.deepEqual(eco.grant('a', 40), { ok: true, coin: 45 });
  for (const bad of [0, -5, 1.5, '3', NaN]) assert.equal(eco.grant('a', bad).error, 'BAD_REQUEST');
  const boot = eco.addCatch('a', { speciesId: 'boot', weight: 0.8 }).item;
  assert.equal(eco.state('a').items.length, 1);
  assert.equal(eco.state('a').items[0].price, 2, 'junk is worth a coin or two');
  assert.equal(eco.discard('a', boot.id).ok, true);
  assert.equal(eco.state('a').items.length, 0);
  assert.equal(eco.state('a').coin, 45, 'nothing was paid');
  assert.equal(eco.discard('a', boot.id).error, 'NOT_FOUND');
});

// ---------------- seagulls ----------------

function gullSetup(over = {}) {
  const eco = economy();
  let clock = 1000;
  const sent = [];
  const player = { pid: 'p1', profileId: 'a', lastCatch: { itemId: 'x' }, seagull: null };
  const gulls = new Seagulls({
    economy: eco, now: () => clock, rng: () => 0, emit: (p, e, d) => sent.push([e, d]), bagChanged: () => sent.push(['bag']),
    config: { seagullChance: 1, seagullReadyMs: 900, seagullWindowMs: 2600, ...over },
  });
  const catchFish = (id = 'carp') => eco.addCatch('a', { speciesId: id, weight: 2 }).item;
  return { eco, gulls, player, sent, catchFish, tick: (ms) => { clock += ms; } };
}

test('a seagull: shoo it after it swoops and the fish is yours; too early does nothing; too late (or never) and it is gone', async () => {
  const S = gullSetup();
  const fish = S.catchFish();
  assert.equal(S.gulls.maybe(S.player, fish, FISH.find((f) => f.id === 'carp')), true);
  assert.deepEqual(S.sent[0], ['seagull:attack', { speciesId: 'carp', readyMs: 900, windowMs: 2600 }]);
  assert.equal(S.player.lastCatch, null, 'nobody can steal a fish a gull is after');
  assert.deepEqual(S.gulls.shoo(S.player), { ok: false, error: 'TOO_EARLY' });
  S.tick(1000);
  assert.deepEqual(S.gulls.shoo(S.player), { ok: true });
  assert.deepEqual(S.sent.at(-1), ['seagull:result', { stolen: false, speciesId: 'carp' }]);
  assert.equal(S.eco.state('a').items.length, 1, 'still in the bag');
  assert.equal(S.gulls.shoo(S.player).error, 'NO_SEAGULL');

  const late = gullSetup();
  const f2 = late.catchFish();
  late.gulls.maybe(late.player, f2, FISH.find((f) => f.id === 'carp'));
  late.tick(2700);
  assert.deepEqual(late.gulls.shoo(late.player), { ok: false, error: 'TOO_LATE' });

  // never shooed: the timer takes the fish
  const quick = gullSetup({ seagullWindowMs: 60, seagullReadyMs: 10 });
  const f3 = quick.catchFish();
  quick.gulls.maybe(quick.player, f3, FISH.find((f) => f.id === 'carp'));
  await wait(220);
  assert.deepEqual(quick.sent.find(([e]) => e === 'seagull:result'), ['seagull:result', { stolen: true, speciesId: 'carp' }]);
  assert.equal(quick.eco.state('a').items.length, 0, 'the gull flew off with it');
  assert.equal(quick.eco.state('a').coin, 5);
  assert.equal(quick.player.seagull, null);
});

test('seagulls never take a legendary or a boss, and only come with the chance; cancelling stops the timer', async () => {
  const S = gullSetup();
  assert.equal(S.gulls.maybe(S.player, { id: 'x', speciesId: 'koi' }, { rarity: 'legendary' }), false);
  assert.equal(S.gulls.maybe(S.player, { id: 'x', speciesId: 'nautilus' }, { rarity: 'epic', boss: true }), false);
  assert.equal(S.gulls.maybe(S.player, { id: 'x', speciesId: 'carp' }, undefined), false);
  const off = gullSetup({ seagullChance: 0 });
  assert.equal(off.gulls.maybe(off.player, off.catchFish(), FISH.find((f) => f.id === 'carp')), false);
  const rare = gullSetup();
  rare.gulls.rng = () => 0.9; // a roll above the chance
  rare.gulls.cfg.seagullChance = 0.5;
  assert.equal(rare.gulls.maybe(rare.player, rare.catchFish(), FISH.find((f) => f.id === 'carp')), false);

  const quick = gullSetup({ seagullWindowMs: 60, seagullReadyMs: 10 });
  quick.gulls.maybe(quick.player, quick.catchFish(), FISH.find((f) => f.id === 'carp'));
  quick.gulls.cancelFor(quick.player);
  await wait(200);
  assert.equal(quick.eco.state('a').items.length, 1, 'a player who left keeps their fish');
});

// ---------------- chests ----------------

function chestSetup(over = {}) {
  const store = new MemoryStore();
  const eco = new Economy({ store, species: [...FISH, ...TRASH], equipment: EQUIPMENT });
  for (const id of ['a', 'b']) store.createProfile({ id, tokenHash: id, name: id, coin: 0, owned: [], equipped: {}, createdAt: 0 });
  let clock = 1000;
  const sent = [];
  const room = { code: 'ROOM', players: [] };
  const mk = (pid, profileId, x, y) => ({ pid, profileId, x, y, mapId: 'lake', connected: true, room });
  const A = mk('pa', 'a', 100, 100);
  const B = mk('pb', 'b', 110, 100);
  room.players.push(A, B);
  const chests = new Chests({
    economy: eco, now: () => clock, rng: () => 0.5, emitRoom: (r, e, d) => sent.push([e, d]), bagChanged: () => {},
    config: { chest: { lifeMs: 45000, openWindowMs: 1500, range: 36, coins: [80, 260], ...over } },
  });
  return { eco, chests, room, A, B, sent, tick: (ms) => { clock += ms; } };
}

test('a chest needs both players: the first press waits, the second within the window opens it and the coins are split', () => {
  const S = chestSetup();
  assert.deepEqual(S.chests.open(S.A), { ok: false, error: 'NO_CHEST' });
  S.chests.spawn(S.A);
  assert.equal(S.sent[0][0], 'chest:spawn');
  assert.equal(S.room.chest.x, 100);
  assert.deepEqual(S.chests.open(S.A), { ok: true, waiting: true, windowMs: 1500 });
  assert.equal(S.eco.state('a').coin, 0);
  S.tick(1000);
  const r = S.chests.open(S.B);
  assert.equal(r.opened, true);
  const total = 80 + Math.floor(0.5 * (260 - 80 + 1));
  assert.equal(r.each, Math.floor(total / 2));
  assert.equal(S.eco.state('a').coin, r.each);
  assert.equal(S.eco.state('b').coin, r.each);
  assert.deepEqual(S.sent.at(-1)[1].by.sort(), ['pa', 'pb']);
  assert.equal(S.room.chest, null, 'gone once opened');
  assert.equal(S.chests.open(S.A).error, 'NO_CHEST');
});

test('chest limits: too far away, presses too far apart, a new chest replaces the old one', () => {
  const S = chestSetup();
  S.chests.spawn(S.A);
  S.B.x = 100 + 80;
  assert.equal(S.chests.open(S.B).error, 'TOO_FAR');
  S.B.x = 110;
  S.chests.open(S.A);
  S.tick(1600);
  assert.deepEqual(S.chests.open(S.B), { ok: true, waiting: true, windowMs: 1500 }, 'the first press has expired');
  S.tick(500);
  assert.equal(S.chests.open(S.A).opened, true, 'and now it is A who completes the pair');
  S.chests.spawn(S.A);
  const first = S.room.chest.id;
  S.chests.spawn(S.B);
  assert.notEqual(S.room.chest.id, first);
  S.B.mapId = 'ocean';
  assert.equal(S.chests.open(S.B).error, 'TOO_FAR', 'a chest is on one map');
  S.chests.cancelRoom(S.room);
  assert.equal(S.room.chest, null);
});

// ---------------- over the wire ----------------

let server;
let rngSeed = 7;
const sockets = [];
const rng = () => ((rngSeed = (rngSeed * 1664525 + 1013904223) % 4294967296) / 4294967296);
before(async () => {
  server = await createGameServer({
    port: 0, graceMs: 200, world: false, rng,
    random: { trashChance: 1, chestChance: 0, fakeLegendaryChance: 1, seagullChance: 0 },
    fishing: { BITE_MIN_MS: 40, BITE_MAX_MS: 40, HOOK_MIN_MS: 400, HOOK_MAX_MS: 400, HOOK_SLACK_MS: 300 },
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

async function twoAtTheWest() {
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
  const west = SPOTS.find((x) => x.id === 'west');
  const mk = (sock, pid, profile, x, y) => ({ sock, pid, profileId: profile.profile.id, me: () => find(pid), put(px, py) { Object.assign(find(pid), { x: px, y: py }); } });
  const A = mk(a, created.pid, ha);
  const B = mk(b, joined.pid, hb);
  A.put(west.x, west.y);
  B.put(west.x - 12, west.y);
  return { A, B, west };
}

/** Cast, hook, fight with a perfect bot, finish: resolves {hooked, result}. */
async function landOne(A) {
  const cast = await A.sock.request('fishing:cast', { spotId: 'west', power: 0.5 });
  assert.equal(cast.ok, true, JSON.stringify(cast));
  await A.sock.next('fishing:event', (e) => e.event === 'bite');
  const hooked = A.sock.next('fishing:event', (e) => e.event === 'hooked');
  await A.sock.request('fishing:hook', { id: cast.session.id });
  const h = await hooked;
  const species = [...FISH, ...TRASH].find((x) => x.id === h.speciesId);
  const fight = play(species, bots.fishWatcher(100), h.seed, h.gear, h.weight);
  await wait(Math.ceil((fight.sim.tick / TICK_RATE) * 1000 * 0.82)); // the server will not accept a fight faster than real time
  const result = A.sock.next('fishing:event', (e) => e.event === 'result');
  await A.sock.request('fishing:finish', { id: cast.session.id, toggles: fight.toggles });
  return { hooked: h, result: await result };
}

test('over the wire: the junk is in the bag, worth a coin or two, not counted as a fish, and the tease is flagged', async () => {
  const { A } = await twoAtTheWest();
  const { hooked, result } = await landOne(A);
  assert.equal(hooked.fake, true, 'it came up dressed as a legendary');
  assert.equal(result.outcome, 'caught');
  assert.equal(result.trash, true);
  assert.equal(result.fake, true);
  assert.equal(result.rarity, 'common');
  const bag = server.economy.state(A.profileId).items;
  assert.equal(bag.length, 1);
  assert.ok(TRASH.some((t) => t.id === bag[0].speciesId));
  assert.ok(bag[0].price <= 130);
  assert.deepEqual(A.me().stats, { caught: 0, biggest: 0, rare: 0, rescues: 0 }, 'junk is not a fish for the scoreboard');
  assert.equal(A.me().lastCatch, null, 'and nobody steals a boot');
}, { timeout: 20000 });

test('over the wire: a fished-up chest appears for both, and only opens when both press it together', async () => {
  const chestServer = await createGameServer({
    port: 0, graceMs: 200, world: false, rng,
    random: { trashChance: 0, chestChance: 1, fakeLegendaryChance: 0, seagullChance: 0, chest: { lifeMs: 30000, openWindowMs: 1500, range: 36, coins: [100, 100] } },
    fishing: { BITE_MIN_MS: 40, BITE_MAX_MS: 40, HOOK_MIN_MS: 400, HOOK_MAX_MS: 400, HOOK_SLACK_MS: 300 },
  });
  const previous = server;
  server = chestServer;
  try {
    const { A, B } = await twoAtTheWest();
    const seenA = A.sock.next('chest:spawn', () => true, 30000);
    const seenB = B.sock.next('chest:spawn', () => true, 30000);
    const { result } = await landOne(A);
    assert.equal(result.chest, true);
    assert.equal(server.economy.state(A.profileId).items.length, 0, 'a chest is not kept in the bag');
    const spawn = await seenA;
    assert.deepEqual(spawn, await seenB);
    assert.deepEqual([spawn.x, spawn.y], [A.me().x, A.me().y]);
    assert.deepEqual(await A.sock.request('chest:open'), { ok: true, waiting: true, windowMs: 1500 });
    assert.equal(server.economy.state(B.profileId).coin, 0);
    const opened = A.sock.next('chest:opened');
    assert.equal((await B.sock.request('chest:open')).opened, true);
    assert.equal((await opened).each, 50);
    assert.equal(server.economy.state(A.profileId).coin, 50);
    assert.equal(server.economy.state(B.profileId).coin, 50);
  } finally {
    server = previous;
    sockets.forEach((c) => c.disconnect());
    await chestServer.close();
  }
}, { timeout: 20000 });
