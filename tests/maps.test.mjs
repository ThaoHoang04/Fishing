import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LAKE_MAP, OCEAN_MAP, MAPS, getMap, spawnPoint, portalAt } from '../src/data/maps.js';
import { isBlocked, isWaterAt, moveFeet, feetRect, hullRect, bodyRect } from '../src/systems/Collision.js';
import { WATER_RECT, DOCK_RECT } from '../src/data/world.js';

test('the lake behaves exactly as before: water blocks, the pier is walkable, trees are solid, the world has edges', () => {
  assert.equal(isBlocked(feetRect(450, 300)), true, 'in the water');
  assert.equal(isBlocked(feetRect(320, 300)), false, 'on the pier');
  assert.equal(isBlocked(feetRect(300, 300)), true, 'half on the pier, half in the water');
  assert.equal(isBlocked(feetRect(40, 60)), true, 'inside a tree trunk');
  assert.equal(isBlocked(feetRect(-2, 100)), true);
  assert.equal(isBlocked(feetRect(256, 410)), false, 'spawn point is free');
  assert.equal(isWaterAt(450, 300), true);
  assert.equal(isWaterAt(320, 300), false, 'planks are not water');
  assert.equal(isWaterAt(50, 50), false);
  // the default map argument is the lake
  assert.equal(isBlocked(feetRect(450, 300)), isBlocked(feetRect(450, 300), LAKE_MAP));
});

test('the maps are consistent plain data', () => {
  assert.deepEqual(Object.keys(MAPS).sort(), ['frost', 'lake', 'ocean']);
  assert.equal(getMap('nowhere'), null);
  for (const [id, m] of Object.entries(MAPS)) {
    assert.equal(m.id, id);
    assert.ok(m.width > 100 && m.height > 100);
    assert.ok(['walk', 'boat'].includes(m.movement));
    for (const key of ['water', 'walkable', 'land', 'solids', 'portals']) assert.ok(Array.isArray(m[key]), `${id}.${key}`);
    for (const r of [...m.water, ...m.walkable, ...m.land, ...m.solids]) {
      assert.ok(r.w > 0 && r.h > 0, `${id}: empty rect`);
      assert.ok(r.x >= 0 && r.y >= 0 && r.x + r.w <= m.width && r.y + r.h <= m.height, `${id}: rect outside the map ${JSON.stringify(r)}`);
    }
  }
  assert.equal(LAKE_MAP.movement, 'walk');
  assert.equal(OCEAN_MAP.movement, 'boat');
  assert.deepEqual(LAKE_MAP.water[0], WATER_RECT);
  assert.deepEqual(LAKE_MAP.walkable[0], DOCK_RECT);
});

test('at sea a boat sails on open water and is stopped by islands, rocks and the map edge', () => {
  const sea = OCEAN_MAP;
  assert.equal(isBlocked(hullRect(480, 400), sea), false, 'open water');
  const island = sea.land[0]; // north-west island
  assert.equal(isBlocked(hullRect(island.x + 40, island.y + 40), sea), true, 'on an island');
  assert.equal(isBlocked(hullRect(island.x + island.w / 2, island.y + island.h + 30), sea), false, 'just off its shore');
  assert.equal(isBlocked(hullRect(sea.solids[0].x + 8, sea.solids[0].y + 6), sea), true, 'a rock');
  assert.equal(isBlocked(hullRect(-3, 300), sea), true);
  assert.equal(isBlocked(hullRect(500, sea.height + 5), sea), true);
  // a boat is wider than a person: it cannot squeeze where feet can
  assert.ok(hullRect(0, 0).w > feetRect(0, 0).w);
  assert.deepEqual(bodyRect(10, 10, sea), hullRect(10, 10));
  assert.deepEqual(bodyRect(10, 10, LAKE_MAP), feetRect(10, 10));
});

test('a boat slides along an island instead of sticking to it, and never ends up inside land', () => {
  const sea = OCEAN_MAP;
  const isle = sea.land[1]; // east island
  let x = isle.x - 30;
  let y = isle.y + isle.h / 2;
  for (let i = 0; i < 200; i++) {
    ({ x, y } = moveFeet(x, y, 1, 0.6, sea)); // push diagonally into the shore
    assert.equal(isBlocked(hullRect(x, y), sea), false, `inside land at step ${i}`);
    if (y - 8 < isle.y + isle.h) assert.ok(x + 8 <= isle.x + 0.001, 'while level with the island it stays off its shore');
  }
  assert.ok(y > isle.y + isle.h / 2 + 10, 'it slid along the coast (and then around the corner)');
});

test('bobbers land in open sea but never on land (so every cast needs real water)', () => {
  assert.equal(isWaterAt(480, 400, OCEAN_MAP), true);
  assert.equal(isWaterAt(OCEAN_MAP.land[0].x + 20, OCEAN_MAP.land[0].y + 20, OCEAN_MAP), false);
  assert.equal(isWaterAt(OCEAN_MAP.solids[0].x + 4, OCEAN_MAP.solids[0].y + 4, OCEAN_MAP), false);
  assert.equal(isWaterAt(-1, 5, OCEAN_MAP), false);
});

test('spawns are free to stand on, and travelling puts you somewhere free on the other map', () => {
  for (const m of Object.values(MAPS)) {
    for (const [name, value] of Object.entries(m.spawns)) {
      for (const p of Array.isArray(value) ? value : [value]) {
        assert.equal(isBlocked(bodyRect(p.x, p.y, m), m), false, `${m.id} spawn "${name}" at ${p.x},${p.y} is blocked`);
      }
    }
  }
  assert.deepEqual(spawnPoint(OCEAN_MAP, 'harbor'), { x: 480, y: 660 });
  assert.deepEqual(spawnPoint(LAKE_MAP, 'dock'), { x: 326, y: 190 });
  assert.deepEqual(spawnPoint(LAKE_MAP, undefined, 1), { x: 384, y: 410 }, 'no name = the slot\'s default spawn');
  assert.deepEqual(spawnPoint(LAKE_MAP, 'nope', 0), { x: 256, y: 410 });
});

test('portals link the maps both ways, and each arrival point is not inside the destination\'s portal pull-trap', () => {
  for (const m of Object.values(MAPS)) {
    for (const p of m.portals) {
      const target = getMap(p.to);
      assert.ok(target, `${p.id} leads to a map that does not exist`);
      assert.ok(target.spawns[p.spawn] && !Array.isArray(target.spawns[p.spawn]), `${p.id}: unknown spawn ${p.spawn}`);
      assert.ok(target.portals.some((q) => q.to === m.id), `${target.id} has no way back to ${m.id}`);
      // you can actually stand at the portal on its own map
      assert.equal(isBlocked(bodyRect(p.x, p.y, m), m), false, `${p.id} is unreachable (blocked)`);
    }
  }
  const lake = portalAt(LAKE_MAP, 324, 180);
  assert.equal(lake.to, 'ocean');
  assert.equal(portalAt(LAKE_MAP, 100, 100), null);
  assert.equal(portalAt(OCEAN_MAP, 480, 668).to, 'lake');
  assert.ok(portalAt(LAKE_MAP, 324 + 20, 180, 8), 'tolerance widens the pull');
});

test('every part of the ocean the boat should reach really is reachable from the harbour (no sealed-off water)', () => {
  const step = 8;
  const seen = new Set();
  const start = OCEAN_MAP.spawns.harbor;
  const queue = [[Math.round(start.x / step) * step, Math.round(start.y / step) * step]];
  const key = (x, y) => `${x},${y}`;
  while (queue.length) {
    const [x, y] = queue.pop();
    if (seen.has(key(x, y))) continue;
    if (isBlocked(hullRect(x, y), OCEAN_MAP)) continue;
    seen.add(key(x, y));
    for (const [dx, dy] of [[step, 0], [-step, 0], [0, step], [0, -step]]) queue.push([x + dx, y + dy]);
  }
  let openCells = 0;
  for (let y = 16; y < OCEAN_MAP.height - 8; y += step) {
    for (let x = 16; x < OCEAN_MAP.width - 8; x += step) {
      if (!isBlocked(hullRect(x, y), OCEAN_MAP)) {
        openCells++;
        assert.ok(seen.has(key(x, y)), `open water at ${x},${y} cannot be reached from the harbour`);
      }
    }
  }
  assert.ok(openCells > 4000, 'most of the map is sea');
  assert.ok(seen.size >= openCells * 0.95);
});
