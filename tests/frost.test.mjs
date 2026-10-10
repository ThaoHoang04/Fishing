import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RoomManager } from '../server/rooms.js';
import { MAPS, getMap } from '../src/data/maps.js';
import { isBlocked, bodyRect } from '../src/systems/Collision.js';

function sailors() {
  const rooms = new RoomManager({});
  const { room, player: A } = rooms.create('Ann');
  const { player: B } = rooms.join(room.code, 'Ben');
  room.phase = 'playing';
  for (const p of [A, B]) Object.assign(p, { connected: true, mapId: 'ocean', x: 480, y: 660 });
  return { rooms, A, B };
}

test('the ocean has a way north to the Frozen Bay, and the bay a way back; both ends are open water', () => {
  const S = sailors();
  S.A.x = 890; S.A.y = 70; // the north portal
  const there = S.rooms.travel(S.A, 'ocean_north');
  assert.equal(there.ok, true);
  assert.equal(there.mapId, 'frost');
  const frost = getMap('frost');
  assert.equal(isBlocked(bodyRect(there.x, there.y, frost), frost), false, 'you arrive on water');
  assert.equal(S.rooms.travel(S.A, 'ocean_north').error, 'NO_PORTAL', 'that portal is on the other map');
  const back = S.rooms.travel(S.A, 'frost_gate');
  assert.equal(back.ok, true);
  assert.equal(back.mapId, 'ocean');
  assert.equal(isBlocked(bodyRect(back.x, back.y, MAPS.ocean), MAPS.ocean), false);
});

test('a shared boat sails into the bay together; the passenger cannot steer it through', () => {
  const S = sailors();
  S.A.x = 890; S.A.y = 70; S.B.x = 890; S.B.y = 70;
  assert.equal(S.rooms.board(S.B).ok, true);
  assert.equal(S.rooms.travel(S.B, 'ocean_north').error, 'PASSENGER');
  assert.equal(S.rooms.travel(S.A, 'ocean_north').ok, true);
  assert.equal(S.A.mapId, 'frost');
  assert.equal(S.B.mapId, 'frost');
});

test('the Frozen Bay is plain map data: islands and rocks do not overlap the portal or the spawn', () => {
  const frost = MAPS.frost;
  for (const point of [frost.spawns.gate, frost.portals[0]]) {
    assert.equal(isBlocked(bodyRect(point.x, point.y, frost), frost), false);
  }
  for (const to of Object.values(MAPS).flatMap((m) => m.portals.map((p) => p.to))) assert.ok(getMap(to), to);
});
