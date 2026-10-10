import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RoomManager } from '../server/rooms.js';

/** Two players on one shared boat (A drives, B rides), both in FIGHT mode, with a hand-cranked clock. */
function boat() {
  let clock = 1_000_000;
  const events = { capsize: [] };
  const rooms = new RoomManager({ now: () => clock, capsizeMs: 80, onCapsize: (crew, by) => events.capsize.push({ pids: crew.map((p) => p.pid), by: by?.pid ?? null }) });
  const { room, player: A } = rooms.create('Ann');
  const { player: B } = rooms.join(room.code, 'Ben');
  room.phase = 'playing';
  for (const p of [A, B]) Object.assign(p, { mapId: 'ocean', x: 300, y: 400, facing: 'up', connected: true, friendly: false });
  assert.equal(rooms.board(B).ok, true);
  return { rooms, A, B, events, advance: (ms) => { clock += ms; } };
}

test('the passenger can shove the driver overboard: only the driver is dunked, the shover keeps the boat', () => {
  const S = boat();
  const res = S.rooms.attack(S.B, 'push');
  assert.equal(res.ok, true);
  assert.equal(res.shoved, true);
  assert.equal(S.A.seat, null);
  assert.equal(S.B.seat, null);
  assert.ok(S.A.capsizedUntil > 0 && S.A.stunnedUntil > 0, 'the victim splashes about');
  assert.equal(S.B.capsizedUntil, 0, 'the shover does not');
  assert.deepEqual(S.events.capsize, [{ pids: [S.A.pid], by: S.B.pid }]);
});

test('the driver can shove the passenger overboard too, and the victim is back after a few seconds', async () => {
  const S = boat();
  assert.equal(S.rooms.attack(S.A, 'push').ok, true);
  assert.ok(S.B.capsizedUntil > 0);
  await new Promise((r) => setTimeout(r, 140));
  assert.equal(S.B.capsizedUntil, 0);
  assert.equal(S.B.stunnedUntil, 0);
});

test('Friendly mode protects, on either side', () => {
  const S = boat();
  S.B.friendly = true;
  assert.equal(S.rooms.attack(S.A, 'push').error, 'TARGET_FRIENDLY');
  assert.equal(S.A.seat, 'driver', 'nothing happened');
  S.B.friendly = false;
  S.A.friendly = true;
  assert.equal(S.rooms.attack(S.A, 'push').error, 'FRIENDLY');
});

test('it has a cooldown, and slap / bonk still do nothing on a boat', () => {
  const S = boat();
  assert.equal(S.rooms.attack(S.A, 'slap').error, 'NOT_HERE');
  assert.equal(S.rooms.attack(S.A, 'bonk').error, 'NOT_HERE');
  assert.equal(S.rooms.attack(S.A, 'push').ok, true);
  assert.equal(S.A.seat, null, 'the shover is alone on the boat now');
  assert.equal(S.rooms.attack(S.A, 'push').error, 'NOT_HERE', 'nobody left to shove');
});

test('the big shove from a boat needs a full anger meter and spends it', () => {
  const S = boat();
  assert.equal(S.rooms.attack(S.A, 'big').error, 'NOT_ANGRY');
  S.A.anger = 100;
  assert.equal(S.rooms.attack(S.A, 'big').ok, true);
  assert.equal(S.A.anger, 0);
});
