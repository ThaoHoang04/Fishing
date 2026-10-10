import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { RARITIES, FISHING } from '../src/systems/FishingRules.js';
import { RARITY_STYLE, formatWeight } from '../src/ui/rarity.js';
import RareToast from '../src/ui/RareToast.js';
import { WATER_RECT, DOCK_RECT } from '../src/data/world.js';

const readJson = (rel) => JSON.parse(readFileSync(new URL(rel, import.meta.url), 'utf8'));
const species = readJson('../src/data/fish.json');
const spots = readJson('../src/data/spots.json');
const behaviours = readJson('../src/data/behaviours.json');
const ICON_SHEET_FRAMES = (96 / 16) * (352 / 16); // fish_icons_16.png: 6 columns x 22 rows

const lakeFish = species.filter((f) => f.region === 'lake');
const oceanFish = species.filter((f) => f.region === 'ocean');
const frostFish = species.filter((f) => f.region === 'frost');

test('the lake still has its 10 species across all four rarities; the ocean adds its own', () => {
  assert.equal(lakeFish.length, 10);
  for (const r of RARITIES) assert.ok(lakeFish.some((f) => f.rarity === r), `no ${r} lake species`);
  assert.equal(lakeFish.filter((f) => f.rarity === 'legendary').length, 1);
  assert.ok(oceanFish.length >= 7);
  assert.equal(species.length, lakeFish.length + oceanFish.length + frostFish.length, 'every species belongs to a region');
  for (const r of RARITIES) assert.ok(frostFish.some((f) => f.rarity === r), `no frost ${r} species`);
  assert.equal(frostFish.filter((f) => f.boss).length, 1, 'one frost boss');
  for (const r of RARITIES) assert.ok(oceanFish.some((f) => f.rarity === r), `no ${r} ocean species`);
  assert.equal(oceanFish.filter((f) => f.boss).length, 1, 'one boss');
  assert.equal(oceanFish.find((f) => f.boss).rarity, 'legendary');
});

test('every species is fully specified and sane', () => {
  const ids = new Set();
  const icons = new Set();
  for (const f of species) {
    assert.match(f.id, /^[a-z]+$/);
    assert.ok(!ids.has(f.id), `duplicate id ${f.id}`);
    ids.add(f.id);
    assert.ok(f.name.length > 0);
    assert.ok(RARITIES.includes(f.rarity), `${f.id} rarity`);
    assert.ok(f.minWeight > 0 && f.maxWeight > f.minWeight, `${f.id} weight range`);
    assert.ok(f.basePrice > 0 && f.catchWeight > 0, `${f.id} price / catch weight`);
    assert.ok(behaviours[f.behaviour], `${f.id} behaviour "${f.behaviour}" is defined`);
    assert.ok(f.difficulty > 0 && f.difficulty <= 2, `${f.id} difficulty`);
    assert.ok(Number.isInteger(f.icon) && f.icon >= 0 && f.icon < ICON_SHEET_FRAMES, `${f.id} icon frame ${f.icon}`);
    assert.ok(!icons.has(f.icon), `${f.id} reuses another species' sprite`);
    icons.add(f.icon);
  }
});

test('rarer fish are bigger or worth more (a sane progression), and use every archetype', () => {
  const avgMax = (r) => {
    const group = species.filter((f) => f.rarity === r);
    return group.reduce((s, f) => s + f.maxWeight, 0) / group.length;
  };
  assert.ok(avgMax('common') < avgMax('epic') && avgMax('epic') < avgMax('legendary'));
  assert.ok(new Set(species.map((f) => f.behaviour)).size === Object.keys(behaviours).length, 'every archetype is used');
  // harder fights toward the top of the table
  const harder = (r) => lakeFish.filter((f) => f.rarity === r).reduce((s, f) => s + f.difficulty, 0) / lakeFish.filter((f) => f.rarity === r).length;
  assert.ok(harder('common') < harder('epic') && harder('epic') < harder('legendary'));
});

test('spots: every pool references real species, is non-empty, and every species is catchable somewhere', () => {
  const ids = new Set(species.map((f) => f.id));
  const covered = new Set();
  for (const s of spots) {
    assert.ok(Array.isArray(s.pool) && s.pool.length >= 4, `${s.id} pool`);
    assert.equal(new Set(s.pool).size, s.pool.length, `${s.id} has duplicates`);
    for (const id of s.pool) {
      assert.ok(ids.has(id), `${s.id} lists unknown species ${id}`);
      covered.add(id);
    }
  }
  assert.equal(covered.size, species.length);
});

test('deep water is where the good fish are: epics and legendaries only at the pier', () => {
  const rarityOf = Object.fromEntries(species.map((f) => [f.id, f.rarity]));
  for (const s of spots.filter((x) => !x.map || x.map === 'lake')) {
    const top = s.pool.filter((id) => ['epic', 'legendary'].includes(rarityOf[id]));
    const onPier = s.x >= DOCK_RECT.x - 2 && s.x <= DOCK_RECT.x + DOCK_RECT.w + 2 && s.y >= DOCK_RECT.y - 2;
    if (!onPier) assert.deepEqual(top, [], `${s.id} is shore water but has ${top}`);
  }
  const tip = spots.find((s) => s.id === 'dock_tip');
  assert.ok(tip.pool.includes('jelly'), 'the legendary lives at the end of the pier');
  assert.equal(spots.filter((s) => s.pool.includes('jelly')).length, 1, 'and only there');
  assert.ok(WATER_RECT.w > 0);
});

test('rarity odds are a proper distribution that favours common fish', () => {
  const w = FISHING.RARITY_WEIGHT;
  assert.deepEqual(Object.keys(w), RARITIES);
  assert.ok(w.common > w.rare && w.rare > w.epic && w.epic > w.legendary);
  assert.equal(Object.values(w).reduce((a, b) => a + b, 0), 100);
});

test('every rarity has display info, and weights format with two decimals', () => {
  for (const r of RARITIES) {
    assert.match(RARITY_STYLE[r].color, /^#[0-9a-f]{6}$/i);
    assert.ok(RARITY_STYLE[r].label.length > 0);
  }
  assert.equal(formatWeight(2.5), '2.50 kg');
  assert.equal(formatWeight(0.02), '0.02 kg');
});

// ---- the rare-catch toast (UI logic without a game engine: a stub scene that swallows every call) ----
function stubScene() {
  const created = [];
  const chain = new Proxy(function () {}, { get: (_t, k) => (k === 'then' ? undefined : chain), apply: () => chain });
  const makeText = (x, y, text) => {
    const obj = { text, destroyed: false, y: 0, setY(v) { this.y = v; return this; }, destroy() { this.destroyed = true; } };
    const proxy = new Proxy(obj, { get: (t, k) => (k in t ? t[k] : () => proxy) });
    created.push(obj);
    return proxy;
  };
  return {
    created,
    scene: { scale: { width: 480 }, add: { text: makeText }, time: { delayedCall() {} }, tweens: { add: ({ onComplete }) => onComplete?.() } },
  };
}
const byId = (id) => species.find((f) => f.id === id);

test('rare toast: the same catch is announced once, however many times the event arrives', () => {
  const { scene, created } = stubScene();
  const toast = new RareToast(scene);
  const info = { key: 'pid1:77', name: 'Alice' };
  assert.equal(toast.show(info, byId('trout'), 2.31), true);
  for (let i = 0; i < 5; i++) assert.equal(toast.show(info, byId('trout'), 2.31), false, 'duplicate must be dropped');
  assert.equal(created.length, 1);
  assert.equal(toast.count, 1);
  assert.equal(toast.show({ key: 'pid1:78', name: 'Alice' }, byId('trout'), 1.1), true, 'a different catch is a new announcement');
});

test('rare toast: wording, article, weight, and a cap on how many stack up', () => {
  const { scene, created } = stubScene();
  const toast = new RareToast(scene);
  toast.show({ key: 'a', name: 'Alice' }, byId('trout'), 2.31);
  toast.show({ key: 'b', name: 'Bob' }, byId('koi'), 7.5);
  toast.show({ key: 'c', name: 'Bob' }, byId('jelly'), 12);
  assert.equal(created[0].text, 'Alice caught a Rare Trout (2.31 kg)!');
  assert.equal(created[1].text, 'Bob caught an Epic Golden Koi (7.50 kg)!');
  assert.equal(created[2].text, 'Bob caught a Legendary Moon Jelly (12.00 kg)!');
  toast.show({ key: 'd', name: 'Alice' }, byId('bass'), 3);
  assert.equal(toast.count, 3, 'at most three on screen');
  assert.equal(created[0].destroyed, true, 'the oldest one makes room');
});
