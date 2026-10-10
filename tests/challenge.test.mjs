import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import Challenges from '../server/challenges.js';
import Economy from '../src/systems/Economy.js';
import MemoryStore from '../src/systems/MemoryStore.js';

const readJson = (rel) => JSON.parse(readFileSync(new URL(rel, import.meta.url), 'utf8'));
const CONFIG = readJson('../src/data/challenges.json');
const FISH = readJson('../src/data/fish.json');
const TRASH = readJson('../src/data/trash.json');
const EQUIPMENT = readJson('../src/data/equipment.json');
const sp = (id) => [...FISH, ...TRASH].find((f) => f.id === id);
const COMMON = FISH.find((f) => f.rarity === 'common');
const RARE = FISH.find((f) => f.rarity === 'rare');
const BOSS = FISH.find((f) => f.boss);

function setup(over = {}) {
  const store = new MemoryStore();
  const eco = new Economy({ store, species: [...FISH, ...TRASH], equipment: EQUIPMENT });
  for (const id of ['a', 'b']) store.createProfile({ id, tokenHash: id, name: id, coin: 0, owned: [], equipped: {}, createdAt: 0 });
  const sent = [];
  const social = { calls: [], together(ps, why) { this.calls.push(['together', ps.map((p) => p.pid), why]); }, stat(p, k) { this.calls.push(['stat', p.pid, k]); } };
  let clock = 1000;
  const room = { code: 'R', phase: 'playing', players: [] };
  const mk = (pid, profileId) => ({ pid, profileId, connected: true, room });
  const A = mk('pa', 'a');
  const B = mk('pb', 'b');
  room.players.push(A, B);
  const rooms = { rooms: new Map([['R', room]]), onChange: () => sent.push(['room-changed']) };
  const ch = new Challenges({
    rooms, economy: eco, config: { ...CONFIG, durationMs: 60_000, ...over }, now: () => clock, rng: () => 0, social,
    emitRoom: (r, e, d) => sent.push([e, d]), bagChanged: () => {}, schedule: false,
  });
  return { ch, room, A, B, eco, sent, social, tick: (ms) => { clock += ms; } };
}
const coins = (S, who) => S.eco.state(who.profileId).coin;
const ends = (S) => S.sent.filter(([e]) => e === 'challenge:end').map(([, d]) => d);

test('contest data: the kinds with a name, a sentence and a unit; sane timings and rewards', () => {
  assert.equal(CONFIG.kinds.length, 5);
  for (const k of CONFIG.kinds) assert.ok(k.id && k.name && k.text && k.unit, k.id);
  assert.equal(CONFIG.durationMs, 180000, 'three minutes, as in the brief');
  assert.ok(CONFIG.reward.winner > CONFIG.reward.tie && CONFIG.reward.tie > CONFIG.reward.loser && CONFIG.reward.loser > 0);
  assert.ok(CONFIG.firstMs > 0 && CONFIG.everyMs[0] <= CONFIG.everyMs[1]);
});

test('a contest needs two players in a running game, and only one at a time', () => {
  const S = setup();
  S.A.connected = false;
  assert.equal(S.ch.start(S.room, 'most'), false, 'one player is not a contest');
  S.A.connected = true;
  S.room.phase = 'lobby';
  assert.equal(S.ch.start(S.room, 'most'), false);
  S.room.phase = 'playing';
  assert.equal(S.ch.start(S.room, 'most'), true);
  assert.equal(S.ch.start(S.room, 'heaviest'), false, 'already on');
  const started = S.sent.find(([e]) => e === 'challenge:start')[1];
  assert.deepEqual([started.kind, started.durationMs, started.scores], ['most', 60000, { pa: 0, pb: 0 }]);
  assert.ok(S.room.challenge);
  S.ch.end(S.room);
});

test('biggest fish: the heaviest single fish counts; junk and the boss do not', () => {
  const S = setup();
  S.ch.start(S.room, 'heaviest');
  S.ch.record(S.A, COMMON, 2);
  S.ch.record(S.A, COMMON, 1);
  S.ch.record(S.B, COMMON, 3.5);
  S.ch.record(S.B, sp('anchor'), 14);
  S.ch.record(S.A, BOSS, 99);
  assert.deepEqual(S.room.challenge.scores, { pa: 2, pb: 3.5 });
  S.ch.end(S.room);
  const r = ends(S)[0];
  assert.equal(r.winner, 'pb');
  assert.deepEqual(r.coins, { pa: CONFIG.reward.loser, pb: CONFIG.reward.winner });
  assert.equal(coins(S, S.B), CONFIG.reward.winner);
  assert.equal(coins(S, S.A), CONFIG.reward.loser);
  assert.deepEqual(S.social.calls, [['together', ['pa', 'pb'], 'challenge'], ['stat', 'pb', 'challengesWon']]);
  assert.equal(S.room.challenge, null);
});

test('most fish, most rare fish, most junk: each counts its own thing', () => {
  const S = setup();
  S.ch.start(S.room, 'most');
  for (let i = 0; i < 3; i++) S.ch.record(S.A, COMMON, 1);
  S.ch.record(S.B, COMMON, 1);
  S.ch.record(S.B, sp('boot'), 1);
  assert.deepEqual(S.room.challenge.scores, { pa: 3, pb: 1 }, 'junk is not a fish');
  S.ch.end(S.room);

  S.ch.start(S.room, 'rare');
  S.ch.record(S.A, COMMON, 1);
  S.ch.record(S.A, RARE, 1);
  S.ch.record(S.B, RARE, 1);
  S.ch.record(S.B, RARE, 2);
  assert.deepEqual(S.room.challenge.scores, { pa: 1, pb: 2 }, 'only rare or better');
  S.ch.end(S.room);

  S.ch.start(S.room, 'trash');
  S.ch.record(S.A, sp('boot'), 1);
  S.ch.record(S.A, COMMON, 1);
  S.ch.record(S.B, sp('tin_can'), 1);
  S.ch.record(S.B, sp('seaweed'), 1);
  assert.deepEqual(S.room.challenge.scores, { pa: 1, pb: 2 }, 'only junk');
  S.ch.end(S.room);
  assert.deepEqual(ends(S).map((r) => r.winner), ['pa', 'pb', 'pb']);
});

test('a tie (or nobody scoring) pays both the same and names no winner; no contest means nothing is recorded', () => {
  const S = setup();
  S.ch.record(S.A, COMMON, 1);
  assert.ok(!S.sent.some(([e]) => e === 'challenge:score'));
  S.ch.start(S.room, 'most');
  S.ch.record(S.A, COMMON, 1);
  S.ch.record(S.B, COMMON, 1);
  S.ch.end(S.room);
  let r = ends(S)[0];
  assert.equal(r.winner, null);
  assert.deepEqual(r.coins, { pa: CONFIG.reward.tie, pb: CONFIG.reward.tie });
  S.ch.start(S.room, 'rare');
  S.ch.end(S.room);
  r = ends(S)[1];
  assert.equal(r.winner, null, 'nobody scored');
  assert.equal(S.social.calls.filter(([k, , w]) => k === 'stat').length, 0, 'no winner, no win counted');
});

test('score updates are announced as they happen; a strange player or fish is ignored', () => {
  const S = setup();
  S.ch.start(S.room, 'most');
  S.sent.length = 0;
  S.ch.record(S.A, COMMON, 1);
  assert.deepEqual(S.sent.at(-1), ['challenge:score', { scores: { pa: 1, pb: 0 } }]);
  const n = S.sent.length;
  S.ch.record({ pid: 'zz', room: S.room }, COMMON, 1);
  S.ch.record(S.A, undefined, 1);
  S.ch.record(S.A, sp('boot'), 1);
  assert.equal(S.sent.length, n, 'nothing announced');
  S.ch.end(S.room);
});

test('when the time runs out by itself the contest ends on its own; if a player left it is called off with no reward', async () => {
  const S = setup({ durationMs: 60 });
  S.ch.start(S.room, 'most');
  S.ch.record(S.A, COMMON, 1);
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(ends(S).length, 1);
  assert.equal(ends(S)[0].winner, 'pa');
  assert.equal(S.room.challenge, null);

  const T = setup();
  T.ch.start(T.room, 'most');
  T.ch.record(T.A, COMMON, 1);
  T.B.connected = false;
  T.ch.cancelFor(T.B);
  const r = ends(T)[0];
  assert.equal(r.cancelled, true);
  assert.equal(r.winner, null);
  assert.deepEqual(r.coins, {});
  assert.equal(coins(T, T.A), 0);
  T.ch.cancelFor(T.B); // harmless a second time
  assert.equal(ends(T).length, 1);
});

test('Fastest Catch: the shortest fight wins, trash and bosses do not count, no catch at all loses', () => {
  const S = setup();
  S.ch.start(S.room, 'fastest');
  S.ch.record(S.A, COMMON, 2, 9.4);
  S.ch.record(S.A, COMMON, 2, 12.0); // slower: ignored
  S.ch.record(S.A, COMMON, 2, 7.26);
  S.ch.record(S.A, sp(TRASH[0].id), 1, 1.0); // junk: ignored
  S.ch.record(S.A, BOSS, 100, 2.0); // boss: ignored
  assert.equal(S.room.challenge.scores.pa, 7.3);
  assert.equal(S.room.challenge.scores.pb, 0);
  S.ch.end(S.room);
  assert.equal(ends(S)[0].winner, 'pa', 'a time beats no time');
  const T = setup();
  T.ch.start(T.room, 'fastest');
  T.ch.record(T.A, COMMON, 2, 9);
  T.ch.record(T.B, COMMON, 2, 6);
  T.ch.end(T.room);
  assert.equal(ends(T)[0].winner, 'pb', 'the lower time wins');
  const U = setup();
  U.ch.start(U.room, 'fastest');
  U.ch.end(U.room);
  assert.equal(ends(U)[0].winner, null, 'nobody caught anything: a tie');
});
