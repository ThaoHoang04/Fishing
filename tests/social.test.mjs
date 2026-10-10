import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { io as connect } from 'socket.io-client';
import initSqlJs from 'sql.js';
import { writeFileSync } from 'node:fs';
import { createGameServer } from '../server/index.js';
import { openSqlStore } from '../server/sqlStore.js';
import SocialService from '../server/social.js';
import MemoryStore from '../src/systems/MemoryStore.js';
import Economy from '../src/systems/Economy.js';
import { defaultMeta, cloneMeta, levelOf, bump, best, once, addFriendship, earnTitles, viewOf } from '../src/systems/Social.js';

const readJson = (rel) => JSON.parse(readFileSync(new URL(rel, import.meta.url), 'utf8'));
const CONFIG = readJson('../src/data/social.json');
const FISH = readJson('../src/data/fish.json');
const TRASH = readJson('../src/data/trash.json');
const BOSSES = readJson('../src/data/bosses.json');
const EQUIPMENT = readJson('../src/data/equipment.json');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------- data ----------------

test('social data: ascending levels, unique titles that read real counters, a memory board for every counter', () => {
  const ats = CONFIG.levels.map((l) => l.at);
  assert.equal(ats[0], 0);
  assert.deepEqual(ats, [...ats].sort((a, b) => a - b));
  assert.equal(new Set(ats).size, ats.length);
  const ids = CONFIG.titles.map((t) => t.id);
  assert.equal(new Set(ids).size, ids.length);
  const known = new Set(CONFIG.memories.map((m) => m.stat));
  for (const t of CONFIG.titles) {
    assert.ok(t.name && t.text && t.min > 0, t.id);
    assert.ok(t.stat === 'level' || known.has(t.stat), `${t.id} reads ${t.stat}, which the memory board does not show`);
  }
  assert.ok(CONFIG.titles.filter((t) => t.stat === 'level').every((t) => t.min < CONFIG.levels.length));
  for (const key of Object.keys(CONFIG.points)) assert.ok(CONFIG.points[key] > 0, key);
  for (const spec of ['Fishing Buddies', 'Chaos Duo', 'Legendary Duo', 'Fish Thief', 'King of Trash', 'Big Fish Hunter', 'Professional Troll', 'Best Friend', 'Legendary Fisher']) {
    assert.ok(CONFIG.titles.some((t) => t.name === spec) || CONFIG.levels.some((l) => l.name === spec), `${spec} from the brief`);
  }
});

// ---------------- the pure rules ----------------

test('levels follow friendship points; counters add up; best/once keep what they should', () => {
  const lv = CONFIG.levels;
  assert.equal(levelOf(0, lv), 0);
  assert.equal(levelOf(lv[1].at - 1, lv), 0);
  assert.equal(levelOf(lv[1].at, lv), 1);
  assert.equal(levelOf(1e9, lv), lv.length - 1);
  const m = defaultMeta();
  bump(m, 'junk');
  bump(m, 'junk', 4);
  assert.equal(m.stats.junk, 5);
  best(m, 'biggest', 3, 'Carp', 'biggestSpecies');
  best(m, 'biggest', 2, 'Perch', 'biggestSpecies');
  assert.deepEqual([m.stats.biggest, m.stats.biggestSpecies], [3, 'Carp']);
  best(m, 'biggest', 7.5, 'Bass', 'biggestSpecies');
  assert.deepEqual([m.stats.biggest, m.stats.biggestSpecies], [7.5, 'Bass']);
  once(m, 'firstFishAt', 111);
  once(m, 'firstFishAt', 999);
  assert.equal(m.stats.firstFishAt, 111);
  assert.deepEqual(addFriendship(m, lv[1].at - 1, lv), { level: 0, levelUp: false });
  assert.deepEqual(addFriendship(m, 1, lv), { level: 1, levelUp: true });
  assert.deepEqual(addFriendship(m, 1, lv), { level: 1, levelUp: false });
});

test('titles are earned once, the first one becomes the shown title, and the view lists everything', () => {
  const m = defaultMeta();
  assert.deepEqual(earnTitles(m, CONFIG), []);
  bump(m, 'stealsWon', 2);
  assert.deepEqual(earnTitles(m, CONFIG), []);
  bump(m, 'stealsWon');
  const got = earnTitles(m, CONFIG);
  assert.deepEqual(got.map((t) => t.id), ['fish_thief']);
  assert.equal(m.active, 'fish_thief');
  assert.deepEqual(earnTitles(m, CONFIG), [], 'only once');
  addFriendship(m, 500, CONFIG.levels);
  const more = earnTitles(m, CONFIG).map((t) => t.id);
  assert.ok(more.includes('buddies') && more.includes('legend'), 'friendship levels unlock their titles');
  assert.equal(m.active, 'fish_thief', 'the shown title does not change by itself');

  const v = viewOf(m, CONFIG);
  assert.equal(v.friendship.level, CONFIG.levels.length - 1);
  assert.equal(v.friendship.next, null);
  assert.equal(v.activeName, 'Fish Thief');
  assert.equal(v.titles.length, CONFIG.titles.length);
  assert.ok(v.titles.find((t) => t.id === 'fish_thief').earned);
  assert.ok(!v.titles.find((t) => t.id === 'troll').earned);
  assert.ok(v.friendship.unlocked.includes('emote_star'));
  // tolerant of old profiles
  for (const odd of [undefined, null, {}, { stats: { caught: 2 } }]) assert.doesNotThrow(() => viewOf(odd, CONFIG));
  assert.deepEqual(cloneMeta(undefined), defaultMeta());
  const c = cloneMeta(m);
  c.stats.caught = 99;
  assert.equal(m.stats.caught, undefined, 'a clone is a copy');
});

// ---------------- the service on a store ----------------

function service() {
  const store = new MemoryStore();
  const eco = new Economy({ store, species: [...FISH, ...TRASH, ...BOSSES], equipment: EQUIPMENT, social: CONFIG });
  for (const id of ['a', 'b']) store.createProfile({ id, tokenHash: id, name: id, coin: 0, owned: [], equipped: {}, createdAt: 0 });
  const sent = [];
  let clock = 5000;
  const room = { players: [] };
  const mk = (pid, profileId, x) => ({ pid, profileId, x, y: 0, mapId: 'lake', connected: true, room });
  const A = mk('pa', 'a', 0);
  const B = mk('pb', 'b', 40);
  room.players.push(A, B);
  const svc = new SocialService({ store, config: CONFIG, now: () => clock, emit: (p, e, d) => sent.push([p.pid, e, d]), changed: (p) => sent.push([p.pid, 'changed']), roomChanged: (p) => sent.push([p.pid, 'room']) });
  return { store, eco, svc, A, B, sent, tick: (ms) => { clock += ms; } };
}
const meta = (S, who) => S.store.getProfile(who.profileId).meta;
const fish = (id) => FISH.find((f) => f.id === id);

test('landing a fish fills the memory board; junk is counted apart; legendary and the biggest are remembered', () => {
  const S = service();
  S.svc.landed(S.A, { species: fish('carp'), weight: 2 });
  S.tick(1000);
  S.svc.landed(S.A, { species: TRASH.find((t) => t.id === 'boot'), weight: 1 });
  S.svc.landed(S.A, { species: fish('perch'), weight: 5 });
  const legend = FISH.find((f) => f.rarity === 'legendary' && !f.boss);
  S.svc.landed(S.A, { species: legend, weight: 12 });
  const m = meta(S, S.A);
  assert.equal(m.stats.caught, 3);
  assert.equal(m.stats.junk, 1);
  assert.equal(m.stats.legendary, 1);
  assert.equal(m.stats.biggest, 12);
  assert.equal(m.stats.biggestSpecies, legend.name);
  assert.equal(m.stats.firstFishAt, 5000, 'the first fish keeps its date');
  assert.equal(m.stats.firstLegendaryAt, 6000);
  assert.deepEqual(S.sent.filter(([, e]) => e === 'social:toast').map(([, , d]) => d.name), ['Legendary Fisher']);
  assert.equal(meta(S, S.B).stats?.caught, undefined, 'only the one who caught it');
});

test('friendship: points for fishing together (only when close), shared moments for both, level-ups announced, never lost', () => {
  const S = service();
  assert.equal(S.svc.friendNear(S.A), S.B);
  S.B.x = 500;
  assert.equal(S.svc.friendNear(S.A), null, 'too far apart to count as together');
  S.B.x = 40;
  S.svc.landed(S.A, { species: fish('carp'), weight: 2, friend: S.B });
  assert.equal(meta(S, S.A).friendship, CONFIG.points.catchTogether);
  S.svc.landed(S.A, { species: fish('carp'), weight: 2, friend: null });
  assert.equal(meta(S, S.A).friendship, CONFIG.points.catchTogether, 'alone: no points');

  S.svc.together([S.A, S.B], 'bossTogether');
  for (const who of [S.A, S.B]) assert.ok(meta(S, who).friendship >= CONFIG.points.bossTogether);
  S.sent.length = 0;
  for (let i = 0; i < 3; i++) S.svc.together([S.A, S.B], 'bossTogether');
  const levelToasts = S.sent.filter(([, e, d]) => e === 'social:toast' && d.kind === 'level');
  assert.ok(levelToasts.length >= 2, 'both players were told about their new level');
  assert.ok(levelToasts.some(([pid]) => pid === 'pa') && levelToasts.some(([pid]) => pid === 'pb'));
  const before = meta(S, S.A).friendship;
  S.svc.stat(S.A, 'pushedFriend');
  S.svc.stat(S.A, 'stealsLost');
  assert.equal(meta(S, S.A).friendship, before, 'trolling never takes friendship away');
});

test('titles from play: earned by counters, announced, and only an earned title can be shown', () => {
  const S = service();
  for (let i = 0; i < 3; i++) S.svc.stat(S.A, 'stealsWon');
  assert.ok(S.sent.some(([pid, e, d]) => pid === 'pa' && e === 'social:toast' && d.name === 'Fish Thief'));
  assert.equal(S.A.titleName, 'Fish Thief');
  assert.ok(S.sent.some(([pid, e]) => pid === 'pa' && e === 'room'), 'the room is told: the title shows next to the name');
  assert.deepEqual(S.svc.chooseTitle(S.A, 'troll'), { ok: false, error: 'NOT_EARNED' });
  assert.deepEqual(S.svc.chooseTitle(S.A, 'nope'), { ok: false, error: 'NOT_EARNED' });
  for (let i = 0; i < 8; i++) S.svc.stat(S.A, 'pushedFriend');
  assert.deepEqual(S.svc.chooseTitle(S.A, 'troll'), { ok: true });
  assert.equal(S.A.titleName, 'Professional Troll');
  assert.deepEqual(S.svc.chooseTitle(S.A, null), { ok: true });
  assert.equal(S.A.titleName, null);
  assert.equal(S.eco.state('a').social.activeName, null);
  assert.equal(S.eco.state('a').social.stats.pushedFriend, 8, 'the memory board travels with the inventory state');
  assert.equal(S.B.titleName ?? null, null);
});

// ---------------- persistence ----------------

test('SQLite keeps the memory board across a restart, and an old database without the column is upgraded in place', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'ft-social-'));
  try {
    const file = path.join(dir, 'game.sqlite');
    const store = await openSqlStore({ file });
    store.createProfile({ id: 'p1', tokenHash: 'h', name: 'P', coin: 5, owned: ['rod_basic'], equipped: { rod: 'rod_basic' }, createdAt: 1 });
    assert.deepEqual(store.getProfile('p1').meta, {}, 'a new profile starts with nothing');
    const p = store.getProfile('p1');
    p.meta = { ...defaultMeta(), friendship: 77, titles: ['fish_thief'], active: 'fish_thief', stats: { stealsWon: 3 } };
    store.saveProfile(p);
    store.close();
    const again = await openSqlStore({ file });
    assert.deepEqual(again.getProfile('p1').meta, p.meta);
    assert.equal(again.getProfile('p1').coin, 5);
    again.close();

    // a database from before this feature: the profiles table has no `meta`
    const old = path.join(dir, 'old.sqlite');
    const SQL = await initSqlJs();
    const db = new SQL.Database();
    db.run('create table profiles (id text primary key, token_hash text not null, name text not null, coin integer not null check (coin >= 0), owned text not null, equipped text not null, created_at integer not null)');
    db.run("insert into profiles values ('old1', 'h', 'Old', 12, '[\"rod_basic\"]', '{\"rod\":\"rod_basic\"}', 1)");
    writeFileSync(old, Buffer.from(db.export()));
    const upgraded = await openSqlStore({ file: old });
    const pr = upgraded.getProfile('old1');
    assert.equal(pr.coin, 12);
    assert.deepEqual(pr.meta, {});
    assert.doesNotThrow(() => viewOf(pr.meta, CONFIG));
    pr.meta = { ...defaultMeta(), friendship: 1 };
    upgraded.saveProfile(pr);
    upgraded.close();
    assert.equal((await openSqlStore({ file: old })).getProfile('old1').meta.friendship, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------- over the wire ----------------

let server;
const sockets = [];
before(async () => {
  server = await createGameServer({ port: 0, graceMs: 200, world: false, boss: { autoTick: false } });
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

test('over the wire: the inventory state carries the memory board, titles show in the room, toasts arrive, strangers cannot pick titles', async () => {
  const a = await client();
  const b = await client();
  const ha = await a.request('profile:hello', { name: 'Ann' });
  await b.request('profile:hello', { name: 'Ben' });
  assert.equal(ha.state.social.friendship.level, 0);
  assert.equal(ha.state.social.titles.length, CONFIG.titles.length);
  assert.deepEqual(await (await client()).request('social:title', { id: 'fish_thief' }), { ok: false, error: 'NO_PROFILE' });
  const created = await a.request('room:create', { name: 'Ann' });
  await b.request('room:join', { code: created.room.code, name: 'Ben' });
  const room = server.rooms.rooms.get(created.room.code);
  const A = room.players.find((p) => p.pid === created.pid);

  for (let i = 0; i < 3; i++) server.social.stat(A, 'stealsWon');
  await wait(100);
  assert.ok(a.got.some(([e, d]) => e === 'social:toast' && d.name === 'Fish Thief'));
  const inv = [...a.got].reverse().find(([e]) => e === 'inv:state')[1];
  assert.equal(inv.social.stats.stealsWon, 3);
  assert.equal(inv.social.activeName, 'Fish Thief');
  const seenByBen = [...b.got].reverse().find(([e, d]) => e === 'room:state' && d.players.some((p) => p.title))?.[1];
  assert.equal(seenByBen.players.find((p) => p.pid === created.pid).title, 'Fish Thief');

  assert.deepEqual(await a.request('social:title', { id: 'troll' }), { ok: false, error: 'NOT_EARNED' });
  for (let i = 0; i < 8; i++) server.social.stat(A, 'pushedFriend');
  assert.deepEqual(await a.request('social:title', { id: 'troll' }), { ok: true });
  await wait(100);
  const after2 = [...b.got].reverse().find(([e]) => e === 'room:state')[1];
  assert.equal(after2.players.find((p) => p.pid === created.pid).title, 'Professional Troll');
  assert.deepEqual(await a.request('social:title', {}), { ok: true }, 'no id = no title');
});
