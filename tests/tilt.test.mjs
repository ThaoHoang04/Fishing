import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RoomManager, TILT_RATE, TILT_DECAY } from '../server/rooms.js';
import { OCEAN_MAP } from '../src/data/maps.js';
import { isBlocked, bodyRect } from '../src/systems/Collision.js';

/** Two players at sea on one shared boat, with a hand-cranked clock. */
function boat(options = {}) {
  let clock = 1_000_000;
  const events = { tilt: [], capsize: [], change: 0 };
  const rooms = new RoomManager({
    now: () => clock, capsizeMs: 80,
    onTilt: (driver, tilt) => events.tilt.push(tilt),
    onCapsize: (crew) => events.capsize.push(crew.map((p) => p.pid)),
    onChange: () => { events.change++; },
    ...options,
  });
  const { room, player: A } = rooms.create('Ann');
  const { player: B } = rooms.join(room.code, 'Ben');
  room.phase = 'playing';
  for (const p of [A, B]) Object.assign(p, { mapId: 'ocean', x: 300, y: 400, facing: 'up', connected: true });
  // B boards A's boat: A drives
  assert.equal(rooms.board(B).ok, true);
  const run = (seconds, { driver = 'right', passenger = 'right', driverMoves = true, passengerLeans = true } = {}) => {
    A.moving = driverMoves;
    A.facing = driver;
    B.leaning = passengerLeans;
    B.facing = passenger;
    for (let i = 0; i < Math.round(seconds * 10); i++) {
      clock += 100;
      rooms.tickBoats(clock);
    }
  };
  return { rooms, room, A, B, run, events, advance: (ms) => { clock += ms; } };
}

test('the boat starts level, and nothing leans while nobody shifts their weight', () => {
  const S = boat();
  assert.equal(S.A.tilt, 0);
  S.run(5, { driverMoves: false, passengerLeans: false });
  assert.equal(S.A.tilt, 0);
  S.run(5, { driverMoves: true, passengerLeans: false });
  assert.equal(S.A.tilt, 0, 'sailing alone sideways does not tip it');
  S.run(5, { driverMoves: false, passengerLeans: true });
  assert.equal(S.A.tilt, 0, 'leaning while the boat is still does not tip it');
  assert.equal(S.events.capsize.length, 0);
});

test('both leaning the same way tips it at a steady rate, and tells both screens as it goes', () => {
  const S = boat();
  S.run(1);
  assert.ok(Math.abs(S.A.tilt - TILT_RATE) < 0.06, `after a second: ${S.A.tilt}`);
  assert.ok(S.events.tilt.length >= 5, 'the lean is reported as it grows');
  assert.ok(S.events.tilt.every((t) => t > 0), 'to the right');
  const left = boat();
  left.run(1, { driver: 'left', passenger: 'left' });
  assert.ok(left.A.tilt < -0.4, 'and the other way for the other side');
  // up/down do not tip a boat
  const vertical = boat();
  vertical.run(5, { driver: 'up', passenger: 'up' });
  assert.equal(vertical.A.tilt, 0);
});

test('opposite sides, or stopping, bring it back to level; it never goes past the limit', () => {
  const S = boat();
  S.run(1.4);
  const high = S.A.tilt;
  assert.ok(high > 0.6 && high < 1);
  S.run(0.5, { driver: 'right', passenger: 'left' });
  assert.ok(S.A.tilt < high, 'balancing each other out');
  S.run(0.5, { passengerLeans: false });
  const calmer = S.A.tilt;
  S.run(Math.ceil(calmer / TILT_DECAY) + 1, { driverMoves: false, passengerLeans: false });
  assert.equal(S.A.tilt, 0, 'level again');
  assert.equal(S.events.tilt.at(-1), 0, 'and the screens are told it is level');
  assert.equal(S.events.capsize.length, 0);
});

test('leaning together for about two seconds flips it: both dunked, off the boat, not hurt, back after a moment', async () => {
  const S = boat();
  S.run(1.8);
  assert.equal(S.events.capsize.length, 0, 'not yet');
  for (let i = 0; i < 10 && S.events.capsize.length === 0; i++) S.run(0.1); // stop the clock the moment it flips
  assert.deepEqual(S.events.capsize, [[S.A.pid, S.B.pid]]);
  for (const p of [S.A, S.B]) {
    assert.equal(p.seat, null);
    assert.equal(p.boatWith, null);
    assert.equal(p.tilt, 0);
    assert.ok(p.stunnedUntil > 0 && p.capsizedUntil === p.stunnedUntil, 'dunked and dizzy');
    assert.equal(S.rooms.view(S.room).players.find((v) => v.pid === p.pid).capsized, true);
  }
  assert.ok(Math.hypot(S.A.x - S.B.x, S.A.y - S.B.y) >= 20, 'the passenger bobs up beside the boat, not on top of it');
  assert.ok(!isBlocked(bodyRect(S.B.x, S.B.y, OCEAN_MAP), OCEAN_MAP), 'in open water');
  // while dunked: no moving, no boarding
  assert.equal(S.rooms.applyMove(S.A, { x: S.A.x + 1, y: S.A.y, facing: 'up', moving: true }).ok, false);
  assert.deepEqual(S.rooms.board(S.B), { ok: false, error: 'CAPSIZED' });
  await new Promise((r) => setTimeout(r, 160));
  for (const p of [S.A, S.B]) {
    assert.equal(p.capsizedUntil, 0);
    assert.equal(p.stunnedUntil, 0);
    assert.equal(S.rooms.view(S.room).players.find((v) => v.pid === p.pid).capsized, false);
  }
  S.advance(1000);
  assert.equal(S.rooms.board(S.B).ok, true, 'they can climb aboard again');
});

test('a flipped boat does not keep flipping, and a crew that left cannot capsize', () => {
  const S = boat();
  S.run(3);
  assert.equal(S.events.capsize.length, 1);
  S.run(3); // nobody is on a shared boat any more
  assert.equal(S.events.capsize.length, 1);
  const T = boat();
  T.run(1);
  T.rooms.leave(T.B);
  T.run(3);
  assert.equal(T.events.capsize.length, 0);
  assert.equal(T.A.tilt, 0);
});

test('the lean data: where the limits sit', () => {
  assert.ok(TILT_RATE > 0.3 && TILT_RATE < 1, 'a couple of seconds, not instant');
  assert.ok(TILT_DECAY > 0 && TILT_DECAY <= 1.5, 'it recovers more slowly than it tips');
});
