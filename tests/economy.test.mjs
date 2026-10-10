import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, rmSync, mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Economy, { INVENTORY_SLOTS, DEFAULT_GEAR, DEFAULT_OWNED, salePrice } from '../src/systems/Economy.js';
import MemoryStore from '../src/systems/MemoryStore.js';
import { openSqlStore } from '../server/sqlStore.js';

const readJson = (rel) => JSON.parse(readFileSync(new URL(rel, import.meta.url), 'utf8'));
const species = readJson('../src/data/fish.json');
const equipment = readJson('../src/data/equipment.json');
const sp = (id) => species.find((s) => s.id === id);

// Every rule below must hold for BOTH stores: the server's SQLite and the offline in-memory one.
const backends = {
  memory: async () => new MemoryStore(),
  sqlite: async () => openSqlStore(),
};

function suite(name, makeStore) {
  const setup = async (clock = { t: 1000 }) => {
    const store = await makeStore();
    const eco = new Economy({ store, species, equipment, now: () => clock.t++ });
    const newProfile = (id = 'p1') => {
      store.createProfile({ id, tokenHash: 'h', name: id, coin: 0, owned: [...DEFAULT_OWNED], equipped: { ...DEFAULT_GEAR }, createdAt: 1 });
      return id;
    };
    const fish = (id, speciesId = 'carp', weight = 2) => eco.addCatch(id, { speciesId, weight }).item;
    return { store, eco, newProfile, fish };
  };

  test(`[${name}] a new profile starts with 0 coins, the three starter items owned and equipped`, async () => {
    const { eco, newProfile } = await setup();
    const id = newProfile();
    const s = eco.state(id);
    assert.deepEqual([s.coin, s.items.length, s.capacity], [0, 0, 20]);
    assert.deepEqual(s.owned.sort(), [...DEFAULT_OWNED].sort());
    assert.deepEqual(s.equipped, DEFAULT_GEAR);
    assert.equal('tokenHash' in s, false);
  });

  test(`[${name}] sale price = basePrice x weight, at least 1 coin`, () => {
    assert.equal(salePrice(sp('carp'), 4), 48);
    assert.equal(salePrice(sp('koi'), 5.08), Math.round(90 * 5.08));
    assert.equal(salePrice(sp('minnow'), 0.02), 1, 'never worth nothing');
    for (const f of species) {
      assert.ok(salePrice(f, f.minWeight) >= 1);
      assert.ok(salePrice(f, f.maxWeight) >= salePrice(f, f.minWeight));
    }
  });

  test(`[${name}] inventory holds exactly 20 fish; the 21st is refused and nothing is lost`, async () => {
    const { eco, newProfile } = await setup();
    const id = newProfile();
    for (let i = 0; i < INVENTORY_SLOTS; i++) assert.equal(eco.addCatch(id, { speciesId: 'minnow', weight: 0.1 }).ok, true);
    assert.equal(eco.isFull(id), true);
    const extra = eco.addCatch(id, { speciesId: 'minnow', weight: 0.1 });
    assert.deepEqual([extra.ok, extra.error], [false, 'INVENTORY_FULL']);
    assert.equal(eco.state(id).items.length, 20);
    eco.sell(id, [eco.state(id).items[0].id]);
    assert.equal(eco.isFull(id), false, 'selling frees a slot');
    assert.equal(eco.addCatch(id, { speciesId: 'minnow', weight: 0.1 }).ok, true);
  });

  test(`[${name}] rejects impossible catches`, async () => {
    const { eco, newProfile } = await setup();
    const id = newProfile();
    for (const bad of [{ speciesId: 'dragon', weight: 1 }, { speciesId: 'carp', weight: 0 }, { speciesId: 'carp', weight: -3 }, { speciesId: 'carp', weight: NaN }]) {
      assert.equal(eco.addCatch(id, bad).error, 'BAD_CATCH');
    }
    assert.equal(eco.state(id).items.length, 0);
  });

  test(`[${name}] selling pays exactly the sum of the sale prices and removes the items`, async () => {
    const { eco, newProfile, fish } = await setup();
    const id = newProfile();
    const a = fish(id, 'carp', 4);
    const b = fish(id, 'trout', 2.5);
    const keep = fish(id, 'perch', 0.6);
    const res = eco.sell(id, [a.id, b.id]);
    assert.deepEqual([res.ok, res.earned], [true, 48 + Math.round(60 * 2.5)]);
    const s = eco.state(id);
    assert.equal(s.coin, res.earned);
    assert.deepEqual(s.items.map((i) => i.id), [keep.id]);
  });

  test(`[${name}] an item can never be sold twice (same request, repeat request, or racing requests)`, async () => {
    const { eco, newProfile, fish } = await setup();
    const id = newProfile();
    const a = fish(id, 'carp', 3);
    assert.equal(eco.sell(id, [a.id, a.id, a.id]).earned, 36, 'duplicate ids in one request pay once');
    assert.equal(eco.state(id).coin, 36);
    const again = eco.sell(id, [a.id]);
    assert.deepEqual([again.ok, again.error], [false, 'NOT_FOUND']);
    assert.equal(eco.sellAll(id).error, 'NOTHING_TO_SELL');
    assert.equal(eco.state(id).coin, 36, 'no extra coins from trying again');
  });

  test(`[${name}] a bad id cancels the whole sale (no partial sales); other players' fish cannot be sold`, async () => {
    const { eco, newProfile, fish } = await setup();
    const me = newProfile('me');
    const other = newProfile('other');
    const mine = fish(me, 'carp', 3);
    const theirs = fish(other, 'carp', 3);
    assert.equal(eco.sell(me, [mine.id, 9999]).error, 'NOT_FOUND');
    assert.equal(eco.sell(me, [mine.id, theirs.id]).error, 'NOT_FOUND');
    assert.equal(eco.state(me).items.length, 1, 'my fish is still there');
    assert.equal(eco.state(me).coin, 0);
    assert.equal(eco.state(other).items.length, 1, 'and theirs too');
    for (const bad of [[], 'x', [1.5], ['1'], [null], null, undefined, new Array(101).fill(1)]) {
      const r = eco.sell(me, bad);
      assert.equal(r.ok, false, JSON.stringify(bad)?.slice(0, 25));
    }
    assert.equal(eco.state(me).coin, 0);
  });

  test(`[${name}] sell all pays everything in the bag`, async () => {
    const { eco, newProfile, fish } = await setup();
    const id = newProfile();
    const items = [fish(id, 'carp', 2), fish(id, 'minnow', 0.1), fish(id, 'koi', 3)];
    const total = items.reduce((s, i) => s + salePrice(sp(i.speciesId), i.weight), 0);
    const res = eco.sellAll(id);
    assert.deepEqual([res.ok, res.earned, res.sold.length], [true, total, 3]);
    assert.equal(eco.state(id).items.length, 0);
    assert.equal(eco.state(id).coin, total);
  });

  test(`[${name}] buying: coin never goes negative, exact change works, nothing is bought on failure`, async () => {
    const { eco, newProfile, fish } = await setup();
    const id = newProfile();
    const price = equipment.find((e) => e.id === 'rod_fiber').price; // 300
    let r = eco.buy(id, 'rod_fiber');
    assert.deepEqual([r.ok, r.error], [false, 'NOT_ENOUGH_COIN']);
    assert.equal(eco.state(id).coin, 0);
    assert.ok(!eco.state(id).owned.includes('rod_fiber'));

    const f = fish(id, 'minnow', 0.1);
    eco.sell(id, [f.id]); // 4 coins
    r = eco.buy(id, 'rod_fiber');
    assert.equal(r.error, 'NOT_ENOUGH_COIN');
    assert.equal(eco.state(id).coin, 4);

    // top up to exactly the price
    const need = price - 4;
    const big = eco.store.addCatch(id, { speciesId: 'carp', weight: need / 12, caughtAt: 1 }); // 12 coins/kg
    eco.sell(id, [big.id]);
    const coinNow = eco.state(id).coin;
    assert.ok(coinNow >= price);
    r = eco.buy(id, 'rod_fiber');
    assert.equal(r.ok, true);
    assert.equal(eco.state(id).coin, coinNow - price);
    assert.ok(eco.state(id).coin >= 0);
    assert.ok(eco.state(id).owned.includes('rod_fiber'));
  });

  test(`[${name}] you cannot buy the same thing twice or something that does not exist; starter gear is free and owned`, async () => {
    const { eco, newProfile } = await setup();
    const id = newProfile();
    assert.equal(eco.buy(id, 'rod_basic').error, 'ALREADY_OWNED');
    assert.equal(eco.buy(id, 'nonsense').error, 'NOT_FOUND');
    eco.store.saveProfile({ ...eco.store.getProfile(id), coin: 1000 });
    assert.equal(eco.buy(id, 'line_braided').ok, true);
    assert.equal(eco.buy(id, 'line_braided').error, 'ALREADY_OWNED');
    assert.equal(eco.state(id).coin, 800, 'charged exactly once');
  });

  test(`[${name}] equip: only owned gear, one slot per type, switching back to starter gear works`, async () => {
    const { eco, newProfile } = await setup();
    const id = newProfile();
    assert.equal(eco.equip(id, 'rod_carbon').error, 'NOT_OWNED');
    assert.equal(eco.state(id).equipped.rod, 'rod_basic');
    eco.store.saveProfile({ ...eco.store.getProfile(id), coin: 5000 });
    for (const e of ['rod_carbon', 'line_titanium', 'bait_golden']) assert.equal(eco.buy(id, e).ok, true);
    for (const e of ['rod_carbon', 'line_titanium', 'bait_golden']) assert.equal(eco.equip(id, e).ok, true);
    assert.deepEqual(eco.state(id).equipped, { rod: 'rod_carbon', line: 'line_titanium', bait: 'bait_golden' });
    const gear = eco.gear(id);
    assert.deepEqual([gear.rod.reelPower, gear.line.maxWeight, gear.bait.rarityModifier.legendary], [23, 60, 4]);
    eco.equip(id, 'rod_basic');
    assert.equal(eco.state(id).equipped.rod, 'rod_basic');
    assert.equal(eco.state(id).equipped.line, 'line_titanium', 'other slots untouched');
    assert.equal(eco.equip(id, 'nonsense').error, 'NOT_FOUND');
  });

  test(`[${name}] random play never breaks the invariants (coin >= 0, coins add up, an item sells at most once)`, async () => {
    const { eco, newProfile } = await setup();
    const id = newProfile();
    let seed = 7;
    const rnd = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);
    let earned = 0;
    let spent = 0;
    const soldEver = new Set();
    for (let step = 0; step < 600; step++) {
      const r = rnd();
      const s = eco.state(id);
      if (r < 0.4) {
        const f = species[Math.floor(rnd() * species.length)];
        eco.addCatch(id, { speciesId: f.id, weight: f.minWeight + rnd() * (f.maxWeight - f.minWeight) });
      } else if (r < 0.65) {
        const pick = s.items.filter(() => rnd() < 0.4).map((i) => i.id);
        if (rnd() < 0.3 && soldEver.size) pick.push([...soldEver][0]); // sometimes try to sell something already sold
        const res = eco.sell(id, pick);
        if (res.ok) {
          earned += res.earned;
          for (const i of res.sold) {
            assert.ok(!soldEver.has(i), `item ${i} sold twice`);
            soldEver.add(i);
          }
        }
      } else if (r < 0.75) {
        const res = eco.sellAll(id);
        if (res.ok) {
          earned += res.earned;
          res.sold.forEach((i) => { assert.ok(!soldEver.has(i)); soldEver.add(i); });
        }
      } else if (r < 0.9) {
        const e = equipment[Math.floor(rnd() * equipment.length)];
        const res = eco.buy(id, e.id);
        if (res.ok) spent += res.price;
      } else {
        eco.equip(id, equipment[Math.floor(rnd() * equipment.length)].id);
      }
      const after = eco.state(id);
      assert.ok(after.coin >= 0, 'coin went negative');
      assert.ok(after.items.length <= INVENTORY_SLOTS);
      assert.equal(after.coin, earned - spent, 'coins must equal earnings minus spending');
      for (const slot of ['rod', 'line', 'bait']) assert.ok(after.owned.includes(after.equipped[slot]), `${slot} equipped but not owned`);
    }
    assert.ok(earned > 0 && spent > 0, 'the run exercised both selling and buying');
  });

  test(`[${name}] a failure half-way through a sale rolls everything back`, async () => {
    const { eco, store, newProfile, fish } = await setup();
    const id = newProfile();
    const a = fish(id, 'carp', 3);
    const b = fish(id, 'carp', 2);
    const original = store.saveProfile.bind(store);
    store.saveProfile = () => { throw new Error('disk on fire'); };
    assert.throws(() => eco.sell(id, [a.id, b.id]), /disk on fire/);
    store.saveProfile = original;
    const s = eco.state(id);
    assert.equal(s.coin, 0, 'no coins from a failed sale');
    assert.equal(s.items.length, 2, 'and the fish are still in the bag');
    assert.equal(eco.sell(id, [a.id, b.id]).ok, true, 'the same sale works afterwards');
    assert.equal(eco.state(id).coin, 36 + 24);
  });

  test(`[${name}] negative coin is rejected by the store itself`, async () => {
    const { store, newProfile } = await setup();
    const id = newProfile();
    assert.throws(() => store.saveProfile({ ...store.getProfile(id), coin: -1 }));
    assert.equal(store.getProfile(id).coin, 0);
  });

  test(`[${name}] FishDex: a species unlocks on its first catch, and keeps count / personal best / first date`, async () => {
    const clock = { t: 1000 };
    const { eco, newProfile } = await setup(clock);
    const id = newProfile();
    assert.deepEqual(eco.state(id).dex, {}, 'nothing discovered yet');

    const first = eco.addCatch(id, { speciesId: 'carp', weight: 3 });
    assert.deepEqual([first.isNew, first.record], [true, false], 'a first catch is NEW, not a record');
    let dex = eco.state(id).dex;
    assert.deepEqual(Object.keys(dex), ['carp']);
    assert.deepEqual([dex.carp.count, dex.carp.biggest], [1, 3]);
    const firstAt = dex.carp.firstAt;

    const smaller = eco.addCatch(id, { speciesId: 'carp', weight: 2 });
    assert.deepEqual([smaller.isNew, smaller.record], [false, false]);
    const bigger = eco.addCatch(id, { speciesId: 'carp', weight: 5.5 });
    assert.deepEqual([bigger.isNew, bigger.record], [false, true], 'beating the old best is a record');
    const equalToBest = eco.addCatch(id, { speciesId: 'carp', weight: 5.5 });
    assert.equal(equalToBest.record, false, 'tying is not beating');

    const other = eco.addCatch(id, { speciesId: 'trout', weight: 1 });
    assert.equal(other.isNew, true);
    dex = eco.state(id).dex;
    assert.deepEqual([dex.carp.count, dex.carp.biggest, dex.trout.count], [4, 5.5, 1]);
    assert.equal(dex.carp.firstAt, firstAt, 'the discovery date never moves');
  });

  test(`[${name}] FishDex: selling fish does not forget them, and each player has their own`, async () => {
    const { eco, newProfile } = await setup();
    const me = newProfile('me');
    const you = newProfile('you');
    const a = eco.addCatch(me, { speciesId: 'koi', weight: 8 }).item;
    eco.addCatch(you, { speciesId: 'minnow', weight: 0.1 });
    eco.sell(me, [a.id]);
    assert.equal(eco.state(me).items.length, 0);
    assert.deepEqual(eco.state(me).dex.koi, { count: 1, biggest: 8, firstAt: eco.state(me).dex.koi.firstAt });
    assert.deepEqual(Object.keys(eco.state(me).dex), ['koi']);
    assert.deepEqual(Object.keys(eco.state(you).dex), ['minnow']);
    // a new, lighter koi after selling the record one is not a record
    assert.equal(eco.addCatch(me, { speciesId: 'koi', weight: 4 }).record, false);
    assert.equal(eco.state(me).dex.koi.biggest, 8, 'the record outlives the sold fish');
  });

  test(`[${name}] FishDex: a full bag refuses the fish without unlocking anything`, async () => {
    const { eco, newProfile } = await setup();
    const id = newProfile();
    for (let i = 0; i < INVENTORY_SLOTS; i++) eco.addCatch(id, { speciesId: 'minnow', weight: 0.1 });
    assert.equal(eco.addCatch(id, { speciesId: 'jelly', weight: 9 }).error, 'INVENTORY_FULL');
    assert.equal('jelly' in eco.state(id).dex, false);
  });

  test(`[${name}] sold fish stay on record (for the FishDex) but out of the bag`, async () => {
    const { eco, store, newProfile, fish } = await setup();
    const id = newProfile();
    const a = fish(id, 'carp', 3);
    const b = fish(id, 'trout', 1);
    eco.sell(id, [a.id]);
    assert.equal(store.listCatches(id).length, 2);
    assert.deepEqual(store.listCatches(id).map((c) => c.sold), [true, false]);
    assert.deepEqual(store.listCatches(id, { unsold: true }).map((c) => c.id), [b.id]);
  });
}

for (const [name, make] of Object.entries(backends)) suite(name, make);

// ---- persistence ----

test('SQLite: everything survives closing and reopening the database file', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'ft-'));
  const file = path.join(dir, 'game.sqlite');
  try {
    let store = await openSqlStore({ file });
    let eco = new Economy({ store, species, equipment });
    store.createProfile({ id: 'p1', tokenHash: 'abc', name: 'Alice', coin: 0, owned: [...DEFAULT_OWNED], equipped: { ...DEFAULT_GEAR }, createdAt: 5 });
    const a = eco.addCatch('p1', { speciesId: 'carp', weight: 5.5 }).item;
    const b = eco.addCatch('p1', { speciesId: 'trout', weight: 2 }).item;
    eco.sell('p1', [a.id]);
    store.saveProfile({ ...store.getProfile('p1'), coin: store.getProfile('p1').coin + 400 });
    eco.buy('p1', 'rod_fiber');
    eco.equip('p1', 'rod_fiber');
    const before = eco.state('p1');
    store.close();
    assert.ok(existsSync(file));

    store = await openSqlStore({ file });
    eco = new Economy({ store, species, equipment });
    assert.deepEqual(eco.state('p1'), before);
    assert.equal(store.getProfile('p1').tokenHash, 'abc');
    assert.equal(store.getProfile('p1').name, 'Alice');
    assert.deepEqual(store.listCatches('p1').map((c) => [c.id, c.sold]), [[a.id, true], [b.id, false]], 'sold history is kept');
    // ids keep counting up after a restart (no id reuse that could confuse a stale client)
    assert.ok(eco.addCatch('p1', { speciesId: 'minnow', weight: 0.1 }).item.id > b.id);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('SQLite: a failed transaction is not written to the file either', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'ft-'));
  const file = path.join(dir, 'game.sqlite');
  try {
    const store = await openSqlStore({ file });
    const eco = new Economy({ store, species, equipment });
    store.createProfile({ id: 'p1', tokenHash: 'h', name: 'A', coin: 0, owned: [...DEFAULT_OWNED], equipped: { ...DEFAULT_GEAR }, createdAt: 1 });
    const a = eco.addCatch('p1', { speciesId: 'carp', weight: 3 }).item;
    const original = store.saveProfile.bind(store);
    store.saveProfile = () => { throw new Error('boom'); };
    assert.throws(() => eco.sell('p1', [a.id]));
    store.saveProfile = original;
    store.close();
    const reopened = await openSqlStore({ file });
    assert.equal(reopened.getProfile('p1').coin, 0);
    assert.equal(reopened.listCatches('p1', { unsold: true }).length, 1);
    reopened.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('MemoryStore: persist callback fires per committed change and a snapshot restores the same state', async () => {
  const saved = [];
  const store = new MemoryStore({ persist: (s) => saved.push(s) });
  const eco = new Economy({ store, species, equipment });
  store.createProfile({ id: 'p1', tokenHash: 'h', name: 'A', coin: 0, owned: [...DEFAULT_OWNED], equipped: { ...DEFAULT_GEAR }, createdAt: 1 });
  const a = eco.addCatch('p1', { speciesId: 'carp', weight: 3 }).item;
  const n = saved.length;
  eco.sell('p1', [a.id]);
  assert.equal(saved.length, n + 1, 'one persist for the whole sale, not one per step');
  const restored = new Economy({ store: new MemoryStore({ snapshot: saved.at(-1) }), species, equipment });
  assert.deepEqual(restored.state('p1'), eco.state('p1'));
});
