import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { IMAGES, SPRITESHEETS, MAP_ASSETS, TEXTURES, PLAYER_SKINS } from '../src/constants/assetKeys.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8');
const manifest = JSON.parse(read('credits/asset_manifest.json'));
const credits = JSON.parse(read('src/data/credits.json'));

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}
const shipped = walk(path.join(ROOT, 'public', 'assets')).map((f) => path.relative(path.join(ROOT, 'public'), f).split(path.sep).join('/'));

// Parse the license table in ASSET_LICENSES.md into {ID: {credit, used, terms}}.
const rows = Object.fromEntries(
  read('credits/ASSET_LICENSES.md')
    .split('\n')
    .filter((l) => /^\| A\d /.test(l))
    .map((l) => {
      const c = l.split('|').map((x) => x.trim());
      return [c[1], { pack: c[2], terms: c[5], credit: c[6], used: c[7] }];
    }),
);

test('every file that ships in public/assets is listed in the manifest, and the manifest lists nothing that is not there', () => {
  assert.ok(shipped.length > 0);
  assert.deepEqual([...shipped].sort(), Object.keys(manifest).sort());
});

test('every shipped file belongs to a pack with a row in ASSET_LICENSES.md that says it is used in the build', () => {
  for (const [file, pack] of Object.entries(manifest)) {
    assert.ok(rows[pack], `${file}: pack ${pack} has no row in ASSET_LICENSES.md`);
    assert.match(rows[pack].used, /^Yes/, `${file}: ${pack} is listed as not used, but its file ships`);
  }
});

test('packs marked "not used" ship no files; packs marked used ship at least one', () => {
  const byPack = {};
  for (const pack of Object.values(manifest)) byPack[pack] = (byPack[pack] ?? 0) + 1;
  for (const [id, row] of Object.entries(rows)) {
    if (/^Yes/.test(row.used)) assert.ok(byPack[id] > 0, `${id} is listed as used but nothing from it ships`);
    else assert.equal(byPack[id] ?? 0, 0, `${id} is listed as not used but ships ${byPack[id]} file(s)`);
  }
});

test('every pack that ships has a saved copy of its store page / terms', () => {
  const saved = readdirSync(path.join(ROOT, 'credits', 'terms'));
  for (const id of new Set(Object.values(manifest))) {
    assert.ok(saved.some((f) => f.startsWith(`${id}_`)), `no saved terms snapshot for ${id}`);
  }
});

test('every pack whose license asks for credit is credited in the game', () => {
  const credited = new Set(credits.map((c) => c.pack).filter(Boolean));
  for (const id of new Set(Object.values(manifest))) {
    if (/^Required/i.test(rows[id].credit)) assert.ok(credited.has(id), `${id} requires credit but is not in src/data/credits.json`);
  }
  for (const id of credited) assert.ok(rows[id] && /^Yes/.test(rows[id].used), `credits.json credits ${id}, which is not used`);
  for (const c of credits) assert.ok(c.text.length > 10);
});

test('the loader only asks for files that exist, with the pack the manifest says', () => {
  const loaded = [...IMAGES, ...SPRITESHEETS, ...Object.values(MAP_ASSETS).flat()];
  assert.ok(loaded.length >= 15);
  const keys = new Set();
  for (const a of loaded) {
    assert.ok(existsSync(path.join(ROOT, 'public', a.path)), `${a.key}: ${a.path} does not exist`);
    assert.equal(manifest[a.path], a.pack, `${a.path}: loader says ${a.pack}, manifest says ${manifest[a.path]}`);
    assert.ok(!keys.has(a.key), `duplicate texture key ${a.key}`);
    keys.add(a.key);
  }
});

test('nothing is shipped that the game never loads (no dead weight in the build)', () => {
  const loadedPaths = new Set([...IMAGES, ...SPRITESHEETS, ...Object.values(MAP_ASSETS).flat()].map((a) => a.path));
  // ShopUI draws fish icons straight from the sheet in the DOM as well; it is also loaded by the game.
  for (const f of shipped) assert.ok(loadedPaths.has(f), `${f} ships but is never loaded`);
});

test('texture keys: only what the code uses is defined, and the shipped skins match the room slots', () => {
  assert.deepEqual(PLAYER_SKINS, [1, 2]);
  const src = walk(path.join(ROOT, 'src')).filter((f) => f.endsWith('.js') && !f.endsWith('assetKeys.js')).map((f) => readFileSync(f, 'utf8')).join('\n');
  for (const name of Object.keys(TEXTURES)) assert.ok(src.includes(`TEXTURES.${name}`), `TEXTURES.${name} is defined but never used`);
});

test('the shipped art is small, and the first load only fetches what the lake needs', () => {
  const size = (files) => files.reduce((sum, f) => sum + statSync(path.join(ROOT, 'public', f)).size, 0);
  const first = [...IMAGES, ...SPRITESHEETS].map((a) => a.path);
  assert.ok(first.length <= 20, `${first.length} image requests on the first load`);
  assert.ok(size(first) < 120 * 1024, `first load art is ${Math.round(size(first) / 1024)} KB`);
  assert.ok(size(shipped) < 150 * 1024, `all art is ${Math.round(size(shipped) / 1024)} KB`);
  // map-only art is streamed when the player first travels there, not on the first load
  const streamed = Object.values(MAP_ASSETS).flat().map((a) => a.path);
  assert.ok(streamed.length >= 1);
  for (const f of streamed) assert.ok(!first.includes(f), `${f} must not be in the first load`);
});

test('the license table itself is complete: every pack has terms, a credit rule and a verdict', () => {
  assert.equal(Object.keys(rows).length, 8);
  for (const [id, r] of Object.entries(rows)) {
    for (const field of ['terms', 'credit', 'used']) assert.ok(r[field].length > 3, `${id} has no ${field}`);
  }
  assert.match(rows.A1.terms, /NFT|AI/i, 'A1\'s restriction on AI/NFT use is recorded');
});
