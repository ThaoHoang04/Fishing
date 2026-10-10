import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import Rush from '../server/rush.js';

const readJson = (rel) => JSON.parse(readFileSync(new URL(rel, import.meta.url), 'utf8'));
const CONFIG = readJson('../src/data/rush.json');
const FISH = readJson('../src/data/fish.json');

function setup(over = {}) {
  let clock = 1000;
  const sent = [];
  const room = { code: 'R', phase: 'playing', players: [] };
  const mk = (pid) => ({ pid, connected: true, mapId: 'lake', room });
  const A = mk('pa');
  const B = mk('pb');
  room.players.push(A, B);
  const rooms = { rooms: new Map([['R', room]]), onChange: () => {} };
  const stats = [];
  const rush = new Rush({ rooms, species: FISH, spots: ['north', 'west'], config: { ...CONFIG, ...over }, now: () => clock, rng: () => 0, emitRoom: (r, e, d) => sent.push([e, d]), social: { stat: (p, k) => stats.push([p.pid, k]) } });
  return { rush, room, A, B, sent, stats, tick: (ms) => { clock += ms; } };
}

test('rush data: ten seconds, rare or epic lake fish only', () => {
  assert.equal(CONFIG.windowMs, 10000);
  const S = setup();
  assert.ok(S.rush.pool.length >= 3);
  for (const s of S.rush.pool) assert.ok(['rare', 'epic'].includes(s.rarity) && !s.boss && (s.region ?? 'lake') === 'lake');
});

test('a splash needs two players at the lake and only one at a time; it is announced and shows in the room', () => {
  const S = setup();
  S.B.mapId = 'ocean';
  assert.equal(S.rush.spawn(S.room, 'north'), false, 'the friend is at sea');
  S.B.mapId = 'lake';
  assert.equal(S.rush.spawn(S.room, 'north'), true);
  assert.equal(S.rush.spawn(S.room, 'west'), false, 'one at a time');
  assert.equal(S.sent[0][0], 'rush:spot');
  assert.equal(S.sent[0][1].ms, 10000);
  assert.equal(S.room.rush.spotId, 'north');
});

test('the first cast at the spot gets the rare fish; the second is too late and a cast elsewhere gets nothing', () => {
  const S = setup();
  S.rush.spawn(S.room, 'north');
  assert.equal(S.rush.forced(S.A, 'west'), null, 'wrong spot');
  const got = S.rush.forced(S.B, 'north');
  assert.ok(got && S.rush.pool.some((s) => s.id === got.speciesId));
  assert.ok(got.weight > 0);
  assert.equal(S.rush.forced(S.A, 'north'), null, 'too late');
  assert.equal(S.room.rush.claimedBy, 'pb');
  assert.deepEqual(S.stats, [['pb', 'rushClaims']]);
  assert.equal(S.sent.at(-1)[0], 'rush:claimed');
});

test('nobody casts in time: it dives away; a late cast gets nothing', async () => {
  const S = setup({ windowMs: 40 });
  S.rush.spawn(S.room, 'north');
  S.tick(100);
  assert.equal(S.rush.forced(S.A, 'north'), null, 'the window is over even before the timer fires');
  await new Promise((r) => setTimeout(r, 90));
  assert.equal(S.room.rush, null);
  assert.equal(S.sent.at(-1)[0], 'rush:gone');
});
