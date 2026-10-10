import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import Economy, { DEFAULT_GEAR, DEFAULT_OWNED } from '../src/systems/Economy.js';
import MemoryStore from '../src/systems/MemoryStore.js';
import { RoomManager } from '../server/rooms.js';

const readJson = (rel) => JSON.parse(readFileSync(new URL(rel, import.meta.url), 'utf8'));
const EQUIPMENT = readJson('../src/data/equipment.json');
const HATS = readJson('../src/data/hats.json');
const hats = EQUIPMENT.filter((e) => e.type === 'hat');

test('hat data: every priced hat has a picture, rows of equal width, and only palette colours', () => {
  assert.ok(hats.some((h) => h.price === 0), 'a "no hat" choice');
  for (const h of hats.filter((x) => x.price > 0)) {
    const art = HATS[h.id];
    assert.ok(art, `${h.id} has art`);
    const w = art.rows[0].length;
    for (const row of art.rows) {
      assert.equal(row.length, w);
      for (const c of row) assert.ok(c === '.' || art.palette[c], `${h.id}: ${c}`);
    }
    assert.ok(w <= 14 && art.rows.length <= 8, 'small enough to sit on a head');
  }
});

test('hats are bought and worn like gear; "no hat" is free; hats never touch rod, line or bait', () => {
  const store = new MemoryStore();
  const eco = new Economy({ store, species: [], equipment: EQUIPMENT });
  store.createProfile({ id: 'a', tokenHash: 'a', name: 'a', coin: 100, owned: [...DEFAULT_OWNED], equipped: { ...DEFAULT_GEAR }, createdAt: 0 });
  assert.equal(eco.equip('a', 'hat_straw').error, 'NOT_OWNED');
  assert.equal(eco.buy('a', 'hat_straw').ok, true);
  assert.equal(eco.equip('a', 'hat_straw').ok, true);
  assert.equal(eco.state('a').equipped.hat, 'hat_straw');
  assert.equal(eco.state('a').equipped.rod, 'rod_basic');
  assert.equal(eco.buy('a', 'hat_crown').error, 'NOT_ENOUGH_COIN');
  assert.equal(eco.equip('a', 'hat_none').ok, true, 'taking it off costs nothing');
  assert.equal(eco.gear('a').rod.id, 'rod_basic');
});

test('your friend sees your hat in the room snapshot', () => {
  const worn = new Map();
  const rooms = new RoomManager({ hatOf: (p) => worn.get(p.pid) ?? null });
  const { room, player: A } = rooms.create('Ann');
  rooms.join(room.code, 'Ben');
  assert.equal(rooms.view(room).players[0].hat, null);
  worn.set(A.pid, 'hat_party');
  assert.equal(rooms.view(room).players[0].hat, 'hat_party');
});
