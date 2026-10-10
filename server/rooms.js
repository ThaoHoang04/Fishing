import { randomBytes } from 'node:crypto';
import { PLAYER_SPEED, BOAT_SPEED, SWIM_SPEED } from '../src/config.js';
import { isBlocked, bodyRect } from '../src/systems/Collision.js';
import { DEFAULT_MAP_ID, getMap, spawnPoint, portalAt } from '../src/data/maps.js';
import { isRareOrBetter } from '../src/systems/FishingRules.js';
import { allowChat } from '../src/systems/ChatRules.js';
import { MOVES, MOVE_GAP_MS, MODE_LOCK_MS, ANGER_MAX, THROW, FACE_VECTOR, canReach, knockedTo, dryNear, insideRing } from '../src/systems/Combat.js';

export const MAX_PLAYERS = 2;
export const NAME_MAX = 12;
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I
const FACINGS = new Set(['up', 'down', 'left', 'right']);
const BUDGET_MAX = 30; // px of movement a client may "bank" (absorbs packet bunching)
const SPEED_TOLERANCE = 1.25;
export const BOARD_RANGE = 30; // how close the other boat must be to climb aboard
export const TILT_RATE = 0.5; // per second while both lean the same way: the boat flips after about 2 s
export const TILT_DECAY = 0.7; // per second back to level when they stop
export const CAPSIZE_MS = 3500; // how long a flipped crew splashes about before they are put back on their boats
export const BOAT_STILL_MS = 350; // a boat that has not moved for this long is "stopped": passengers may cast
export const SWIM_MS = 3500; // how long a swimmer paddles before climbing out by themselves
export const RESCUE_RANGE = 64; // how far a lifebuoy can be thrown
export const RESCUE_OFFER_MS = 5000; // how long the swimmer has to grab it
export const EMOTE_GAP_MS = 800; // server-side flood guard (the client waits longer)
export const PORTAL_TOLERANCE = 12; // px of slack: position updates are throttled

/**
 * Room + player state, independent of the transport.
 * Server-authoritative for lobby state and player transforms: a move is accepted only if it is
 * reachable at PLAYER_SPEED and not inside a collider (same Collision module as the client).
 */
export class RoomManager {
  /**
   * @param {{graceMs?: number, now?: () => number, onChange?: (room) => void, onRemoved?: (player) => void}} opts
   */
  constructor({ graceMs = 30000, swimMs = SWIM_MS, capsizeMs = CAPSIZE_MS, onProjectileHit = () => {}, now = Date.now, onChange = () => {}, onRemoved = () => {}, onMoved = () => {}, onTilt = () => {}, onCapsize = () => {}, hatOf = () => null } = {}) {
    this.hatOf = hatOf; // (player) -> the id of the hat they wear, or null
    this.rooms = new Map();
    this.capsizeMs = capsizeMs;
    this.onProjectileHit = onProjectileHit; // ({hit result, shot, thrower}): a thrown fish landed
    this.shots = 0;
    this.onTilt = onTilt; // (driver, tilt): how far the shared boat is leaning (-1..1), for both crew members' screens
    this.onCapsize = onCapsize; // ([driver, passenger]): the boat flipped
    this.graceMs = graceMs;
    this.swimMs = swimMs;
    this.onMoved = onMoved; // the server put this player somewhere (a climb out, a rescue): their client must follow
    this.now = now;
    this.onChange = onChange;
    this.onRemoved = onRemoved;
  }

  create(name, profileId = null) {
    const room = { code: this.#newCode(), phase: 'lobby', players: [] };
    this.rooms.set(room.code, room);
    const player = this.#addPlayer(room, name, profileId);
    return { room, player };
  }

  join(code, name, profileId = null) {
    const room = this.rooms.get(normalizeCode(code));
    if (!room) return { error: 'NOT_FOUND' };
    if (room.players.length >= MAX_PLAYERS) return { error: 'ROOM_FULL' };
    const player = this.#addPlayer(room, name, profileId);
    this.onChange(room);
    return { room, player };
  }

  /** Re-attach a returning client to its slot using the secret token. */
  rejoin(code, token) {
    const room = this.rooms.get(normalizeCode(code));
    const player = room?.players.find((p) => p.token === token);
    if (!player) return { error: 'NOT_FOUND' };
    clearTimeout(player.timer);
    player.timer = null;
    player.connected = true;
    this.onChange(room);
    return { room, player };
  }

  setReady(player, ready) {
    const room = player.room;
    if (room.phase !== 'lobby') return;
    player.ready = Boolean(ready);
    if (room.players.length === MAX_PLAYERS && room.players.every((p) => p.ready && p.connected)) {
      room.phase = 'playing';
      for (const p of room.players) this.#spawn(p);
    }
    this.onChange(room);
  }

  /** Session statistics shown to both players: how many fish, the biggest one, how many were rare or better. */
  recordCatch(player, { weight, rarity }) {
    const st = player.stats;
    st.caught++;
    st.biggest = Math.max(st.biggest, weight);
    if (isRareOrBetter(rarity)) st.rare++;
    this.onChange(player.room);
  }

  /** Allow an emote unless this player is spamming them. */
  tryEmote(player) {
    const now = this.now();
    if (now - player.lastEmoteAt < EMOTE_GAP_MS) return false;
    player.lastEmoteAt = now;
    return true;
  }

  /** The server puts a player somewhere (the duel ring, and back): they stop, and the speed check starts fresh from there. */
  place(player, x, y) {
    player.x = x;
    player.y = y;
    player.moving = false;
    player.budget = BUDGET_MAX;
    player.lastMoveAt = this.now();
    this.onChange(player.room);
  }

  /** Friendly mode on/off. Turning it ON is refused for a few seconds after a fight. */
  setFriendly(player, friendly) {
    if (typeof friendly !== 'boolean') return { ok: false, error: 'BAD_REQUEST' };
    if (friendly && !player.friendly && this.now() - player.fightedAt < MODE_LOCK_MS) return { ok: false, error: 'IN_FIGHT' };
    if (friendly !== player.friendly) {
      player.friendly = friendly;
      this.onChange(player.room);
    }
    return { ok: true, friendly };
  }

  /**
   * A cartoon attack ('slap' | 'push' | 'bonk') on the other player. Only on foot, only if neither is in Friendly mode,
   * only at close range in front of you. A miss still costs the cooldown; a hit knocks them back and stuns them.
   * @returns {{ok: false, error: string} | {ok: true, hit: false} | {ok: true, hit: true, target: object, x: number, y: number, stunMs: number}}
   */
  attack(player, kind) {
    const move = MOVES[kind];
    if (!move) return { ok: false, error: 'BAD_MOVE' };
    if (player.room.phase !== 'playing' || !player.connected) return { ok: false, error: 'NOT_PLAYING' };
    const map = getMap(player.mapId);
    if (player.seat && (kind === 'push' || kind === 'big')) return this.#shoveOffBoat(player, move, kind);
    if (map.movement !== 'walk' || player.seat) return { ok: false, error: 'NOT_HERE' };
    const now = this.now();
    if (now < player.stunnedUntil) return { ok: false, error: 'STUNNED' };
    if (player.swimming) return { ok: false, error: 'SWIMMING' };
    if (player.friendly) return { ok: false, error: 'FRIENDLY' };
    if (kind === 'throw') return { ok: false, error: 'BAD_MOVE' }; // thrown with throwItem, not attack
    if (player.room.duel?.has(player)) return { ok: false, error: 'DUEL' }; // a duel has its own moves
    if (move.needsAnger && player.anger < ANGER_MAX) return { ok: false, error: 'NOT_ANGRY' };
    if (now < player.moveReadyAt[kind] || now - player.lastAttackAt < MOVE_GAP_MS) return { ok: false, error: 'COOLDOWN' };
    const target = player.room.players.find((p) => p !== player && p.connected && p.mapId === player.mapId && !p.seat && !p.swimming && canReach(player, p, move));
    if (target?.friendly) return { ok: false, error: 'TARGET_FRIENDLY' }; // no effect and no cooldown: nothing happened
    player.moveReadyAt[kind] = now + move.cooldownMs;
    player.lastAttackAt = now;
    player.fightedAt = now;
    if (move.needsAnger) player.anger = 0; // the big shove is spent whether or not it lands
    if (!target) return { ok: true, hit: false };
    return this.#hit(player.facing, target, move);
  }

  /** Knock `target` back along `facing`, stun them, make them angrier; a push that meets water drops them in. */
  #hit(facing, target, move) {
    const now = this.now();
    const at = knockedTo(getMap(target.mapId), target, facing, move.knock, Boolean(move.fall));
    target.x = at.x;
    target.y = at.y;
    target.moving = false;
    target.budget = BUDGET_MAX;
    target.stunnedUntil = now + move.stunMs;
    target.fightedAt = now;
    this.addAnger(target, move.anger ?? 0);
    if (at.fell) this.#startSwim(target);
    return { ok: true, hit: true, target, x: at.x, y: at.y, stunMs: move.stunMs, fell: at.fell };
  }

  addAnger(player, n) {
    const before = player.anger;
    player.anger = Math.min(ANGER_MAX, player.anger + n);
    if (player.anger !== before) this.onChange(player.room);
  }

  /**
   * Throw a fish or piece of junk (the caller picked which from the bag, and it is NOT used up: this is a joke, not a loss).
   * It flies slowly along `facing`; tickProjectiles() decides whether it hits.
   */
  throwItem(player) {
    if (player.room.phase !== 'playing' || !player.connected) return { ok: false, error: 'NOT_PLAYING' };
    if (getMap(player.mapId).movement !== 'walk' || player.seat) return { ok: false, error: 'NOT_HERE' };
    const now = this.now();
    if (now < player.stunnedUntil) return { ok: false, error: 'STUNNED' };
    if (player.swimming) return { ok: false, error: 'SWIMMING' };
    if (player.friendly) return { ok: false, error: 'FRIENDLY' };
    if (player.room.duel?.has(player)) return { ok: false, error: 'DUEL' };
    if (now < player.moveReadyAt.throw) return { ok: false, error: 'COOLDOWN', ms: player.moveReadyAt.throw - now };
    player.moveReadyAt.throw = now + MOVES.throw.cooldownMs;
    player.fightedAt = now;
    const [fx, fy] = FACE_VECTOR[player.facing] ?? FACE_VECTOR.down;
    const room = player.room;
    room.projectiles ??= [];
    const shot = { id: String(++this.shots), pid: player.pid, mapId: player.mapId, facing: player.facing, x: player.x + fx * 6, y: player.y - 8 + fy * 6, vx: fx * THROW.speed, vy: fy * THROW.speed, last: now, bornAt: now };
    room.projectiles.push(shot);
    return { ok: true, shot: { id: shot.id, x: shot.x, y: shot.y, facing: shot.facing, speed: THROW.speed, ttlMs: THROW.ttlMs } };
  }

  /** Move every flying fish; the first player it reaches (who is not in Friendly mode) takes the hit. Called by a timer. */
  tickProjectiles(now = this.now()) {
    for (const room of this.rooms.values()) {
      if (!room.projectiles?.length) continue;
      room.projectiles = room.projectiles.filter((s) => {
        const dt = Math.max(0, (now - s.last) / 1000);
        s.last = now;
        s.x += s.vx * dt;
        s.y += s.vy * dt;
        const map = getMap(s.mapId);
        if (now - s.bornAt > THROW.ttlMs || s.x < 0 || s.y < 0 || s.x > map.width || s.y > map.height) return false;
        const thrower = room.players.find((p) => p.pid === s.pid);
        const target = room.players.find((p) => p !== thrower && p.connected && p.mapId === s.mapId && !p.seat && !p.swimming && !p.friendly
          && Math.hypot(p.x - s.x, (p.y - 8) - s.y) <= THROW.radius);
        if (!target) return true;
        this.onProjectileHit({ ...this.#hit(s.facing, target, MOVES.throw), shot: s, thrower });
        return false;
      });
    }
  }

  /** Throw a lifebuoy to a swimmer close by. They have RESCUE_OFFER_MS to grab it. */
  rescue(player) {
    if (player.room.phase !== 'playing' || !player.connected) return { ok: false, error: 'NOT_PLAYING' };
    if (getMap(player.mapId).movement !== 'walk' || player.seat) return { ok: false, error: 'NOT_HERE' };
    const now = this.now();
    if (player.swimming) return { ok: false, error: 'SWIMMING' };
    if (now < player.stunnedUntil) return { ok: false, error: 'STUNNED' };
    if (now < player.rescueReadyAt) return { ok: false, error: 'COOLDOWN' };
    const swimmer = player.room.players.find((p) => p !== player && p.connected && p.mapId === player.mapId && p.swimming
      && Math.hypot(p.x - player.x, p.y - player.y) <= RESCUE_RANGE);
    if (!swimmer) return { ok: false, error: 'NO_SWIMMER' };
    player.rescueReadyAt = now + 1000;
    swimmer.offer = { by: player.pid, until: now + RESCUE_OFFER_MS };
    return { ok: true, swimmer, until: swimmer.offer.until };
  }

  /** The swimmer grabs the lifebuoy and is pulled up beside whoever threw it. */
  grab(player) {
    if (player.room.phase !== 'playing' || !player.connected) return { ok: false, error: 'NOT_PLAYING' };
    if (!player.swimming) return { ok: false, error: 'NOT_SWIMMING' };
    const rescuer = player.offer && this.now() < player.offer.until
      ? player.room.players.find((p) => p.pid === player.offer.by && p.connected && p.mapId === player.mapId && !p.swimming
        && Math.hypot(p.x - player.x, p.y - player.y) <= RESCUE_RANGE + 20) // a little slack: the swimmer drifts
      : null;
    if (!rescuer) return { ok: false, error: 'NO_OFFER' };
    const spot = dryNear(getMap(player.mapId), rescuer.x, rescuer.y, 60);
    if (!spot) return { ok: false, error: 'NO_ROOM' };
    player.x = spot.x;
    player.y = spot.y;
    player.stunnedUntil = 0;
    this.#endSwim(player);
    rescuer.stats.rescues++;
    this.onChange(player.room);
    return { ok: true, rescuer, x: spot.x, y: spot.y };
  }

  #startSwim(player) {
    clearTimeout(player.swimTimer);
    player.swimming = true;
    player.offer = null;
    player.swimTimer = setTimeout(() => this.#climbOut(player), this.swimMs);
    player.swimTimer.unref?.();
    this.onChange(player.room);
  }

  #endSwim(player) {
    clearTimeout(player.swimTimer);
    if (!player.swimming) return;
    player.swimming = false;
    player.offer = null;
    this.onChange(player.room);
  }

  /** Nobody came and they did not make it to the shore: they scramble out at the nearest dry spot. */
  #climbOut(player) {
    if (!player.swimming) return;
    const spot = dryNear(getMap(player.mapId), player.x, player.y);
    if (spot) {
      player.x = spot.x;
      player.y = spot.y;
      player.budget = BUDGET_MAX;
      player.lastMoveAt = this.now();
    }
    player.stunnedUntil = 0;
    this.#endSwim(player);
    if (spot) this.onMoved(player);
  }

  /** Allow a chat message unless this player is flooding. */
  tryChat(player) {
    return allowChat(player.chatTimes, this.now());
  }

  /** Voluntary leave: slot is freed immediately. */
  leave(player) {
    this.#remove(player);
  }

  /** Socket dropped: keep the slot for `graceMs` so the player can come back. */
  disconnect(player) {
    if (!player.connected) return;
    player.connected = false;
    player.moving = false;
    this.#unseat(player);
    player.timer = setTimeout(() => this.#remove(player), this.graceMs);
    player.timer.unref?.();
    this.onChange(player.room);
  }

  /**
   * Validate a client-reported transform.
   * @returns {{ok: true, state: object} | {ok: false, correct: {x: number, y: number}}}
   */
  applyMove(player, msg) {
    if (player.seat === 'passenger') return this.#passengerTurn(player, msg);
    const now = this.now();
    if (now < player.stunnedUntil) return { ok: false, correct: { x: player.x, y: player.y } }; // dizzy: stay put
    const map = getMap(player.mapId);
    const speed = player.swimming ? SWIM_SPEED : map.movement === 'boat' ? BOAT_SPEED : PLAYER_SPEED;
    player.budget = Math.min(BUDGET_MAX, player.budget + (speed * SPEED_TOLERANCE * (now - player.lastMoveAt)) / 1000);
    player.lastMoveAt = now;

    const { x, y, facing, moving } = msg ?? {};
    const valid =
      Number.isFinite(x) && Number.isFinite(y) && FACINGS.has(facing) &&
      x >= 0 && y >= 0 && x <= map.width && y <= map.height;
    const ring = valid && player.room.duel?.has(player) ? player.room.duel.ring : null;
    const dist = valid && !(ring && !insideRing(ring, x, y)) ? Math.hypot(x - player.x, y - player.y) : Infinity; // a duellist stays inside the ring
    if (!valid || dist > player.budget || isBlocked(bodyRect(x, y, map), map, player.swimming)) {
      return { ok: false, correct: { x: player.x, y: player.y } };
    }
    player.budget -= dist;
    if (dist > 0.01) player.lastStepAt = now;
    player.x = x;
    player.y = y;
    player.facing = facing;
    player.moving = Boolean(moving);
    if (player.seat === 'driver') {
      player.boatWith.x = x; // the passenger rides along
      player.boatWith.y = y;
    }
    if (player.swimming && !isBlocked(bodyRect(x, y, map), map)) this.#endSwim(player); // reached the shore or the pier
    return { ok: true, state: { pid: player.pid, x, y, facing: player.facing, moving: player.moving, t: msg.t } };
  }

  /**
   * Change map through a portal the player is standing at (the lake pier <-> the open ocean).
   * @returns {{ok: true, mapId: string, x: number, y: number} | {ok: false, error: string}}
   */
  travel(player, portalId) {
    if (player.room.phase !== 'playing') return { ok: false, error: 'NOT_PLAYING' };
    const map = getMap(player.mapId);
    const portal = map.portals.find((p) => p.id === portalId);
    if (!portal) return { ok: false, error: 'NO_PORTAL' };
    if (portalAt(map, player.x, player.y, PORTAL_TOLERANCE)?.id !== portal.id) return { ok: false, error: 'TOO_FAR' };
    if (player.seat === 'passenger') return { ok: false, error: 'PASSENGER' }; // only the driver steers into a harbour
    const target = getMap(portal.to);
    const passenger = player.seat === 'driver' ? player.boatWith : null;
    this.#unseat(player);
    if (passenger) this.#arrive(passenger, target, portal.spawn);
    const at = this.#arrive(player, target, portal.spawn);
    this.onChange(player.room);
    return { ok: true, mapId: target.id, x: at.x, y: at.y };
  }

  #arrive(player, target, spawn) {
    const at = spawnPoint(target, spawn, player.slot);
    player.mapId = target.id;
    player.x = at.x;
    player.y = at.y;
    player.facing = target.movement === 'boat' ? 'up' : 'down';
    player.moving = false;
    player.budget = BUDGET_MAX;
    player.lastMoveAt = this.now();
    return at;
  }

  /** Is the boat `player` is on (their own, or the one they ride) standing still? Fishing from a shared boat needs it. */
  boatStill(player) {
    const driver = player.seat === 'passenger' ? player.boatWith : player;
    return this.now() - driver.lastStepAt >= BOAT_STILL_MS;
  }

  /** Climb aboard the other player's boat (both at sea, close together). The one who was boarded drives. */
  board(player) {
    if (player.room.phase !== 'playing') return { ok: false, error: 'NOT_PLAYING' };
    if (getMap(player.mapId).movement !== 'boat') return { ok: false, error: 'WRONG_MAP' };
    if (player.seat) return { ok: false, error: 'ALREADY_ABOARD' };
    if (this.now() < player.capsizedUntil) return { ok: false, error: 'CAPSIZED' };
    const other = player.room.players.find((p) => p !== player && p.connected && p.mapId === player.mapId);
    if (!other) return { ok: false, error: 'NO_BOAT' };
    if (Math.hypot(other.x - player.x, other.y - player.y) > BOARD_RANGE) return { ok: false, error: 'TOO_FAR' };
    other.seat = 'driver';
    other.boatWith = player;
    player.seat = 'passenger';
    player.boatWith = other;
    player.x = other.x;
    player.y = other.y;
    player.moving = false;
    this.onChange(player.room);
    return { ok: true };
  }

  /** The passenger steps off the boat into the water beside it. */
  disembark(player) {
    if (player.seat !== 'passenger') return { ok: false, error: 'NOT_ABOARD' };
    const map = getMap(player.mapId);
    const { x, y } = player.boatWith;
    const spot = [[0, 28], [0, -28], [28, 0], [-28, 0], [20, 20], [-20, -20]]
      .map(([dx, dy]) => ({ x: x + dx, y: y + dy }))
      .find((p) => p.x >= 0 && p.y >= 0 && p.x <= map.width && p.y <= map.height && !isBlocked(bodyRect(p.x, p.y, map), map));
    if (!spot) return { ok: false, error: 'NO_ROOM' };
    this.#unseat(player);
    player.x = spot.x;
    player.y = spot.y;
    player.budget = BUDGET_MAX;
    player.lastMoveAt = this.now();
    this.onChange(player.room);
    return { ok: true, x: spot.x, y: spot.y };
  }

  /** Swap who steers and who rides. */
  switchSeat(player) {
    if (!player.seat) return { ok: false, error: 'NOT_ABOARD' };
    const other = player.boatWith;
    [player.seat, other.seat] = [other.seat, player.seat];
    player.moving = false;
    other.moving = false;
    this.onChange(player.room);
    return { ok: true, seat: player.seat };
  }

  #unseat(player) {
    const other = player.boatWith;
    player.seat = null;
    player.boatWith = null;
    player.tilt = 0;
    player.leaning = false;
    if (other) {
      other.seat = null;
      other.boatWith = null;
      other.tilt = 0;
      other.leaning = false;
    }
  }

  /**
   * Shared boats lean when both crew members shift their weight the same way (the driver sailing sideways, the passenger
   * pressing the same direction): about two seconds of that and the boat flips and dunks them both. Called by a timer.
   */
  tickBoats(now = this.now()) {
    const side = (facing) => (facing === 'left' ? -1 : facing === 'right' ? 1 : 0);
    for (const room of this.rooms.values()) {
      for (const driver of room.players) {
        if (driver.seat !== 'driver') continue;
        const passenger = driver.boatWith;
        const dt = driver.tiltAt === null ? 0 : Math.min(0.5, (now - driver.tiltAt) / 1000);
        driver.tiltAt = now;
        const d = driver.moving ? side(driver.facing) : 0;
        const p = passenger.leaning ? side(passenger.facing) : 0;
        if (d !== 0 && d === p) driver.tilt += d * TILT_RATE * dt;
        else driver.tilt -= Math.sign(driver.tilt) * Math.min(Math.abs(driver.tilt), TILT_DECAY * dt);
        driver.tilt = Math.max(-1, Math.min(1, driver.tilt));
        if (Math.abs(driver.tilt) >= 1) {
          this.#capsize(driver);
        } else if (Math.abs(driver.tilt - driver.tiltSent) >= 0.04 || (driver.tilt === 0 && driver.tiltSent !== 0)) {
          driver.tiltSent = driver.tilt;
          this.onTilt(driver, driver.tilt);
        }
      }
    }
  }

  /** The boat flipped: both players are in the water for a few seconds (nothing is lost), then back on their own boats. */
  #capsize(driver) {
    const passenger = driver.boatWith;
    const map = getMap(driver.mapId);
    const until = this.now() + this.capsizeMs;
    this.#unseat(driver);
    const spot = [[28, 0], [-28, 0], [0, 28], [0, -28], [20, 20], [-20, -20]]
      .map(([dx, dy]) => ({ x: driver.x + dx, y: driver.y + dy }))
      .find((p) => p.x >= 0 && p.y >= 0 && p.x <= map.width && p.y <= map.height && !isBlocked(bodyRect(p.x, p.y, map), map));
    if (spot) {
      passenger.x = spot.x;
      passenger.y = spot.y;
    }
    for (const p of [driver, passenger]) {
      p.capsizedUntil = until;
      p.stunnedUntil = until;
      p.moving = false;
      p.tiltSent = 0;
      p.budget = BUDGET_MAX;
      p.lastMoveAt = this.now();
      clearTimeout(p.capsizeTimer);
      p.capsizeTimer = setTimeout(() => {
        if (p.capsizedUntil !== until) return;
        p.capsizedUntil = 0;
        p.stunnedUntil = 0;
        this.onChange(p.room);
      }, this.capsizeMs);
      p.capsizeTimer.unref?.();
    }
    this.onCapsize([driver, passenger]);
    this.onChange(driver.room);
  }

  /**
   * K / H from a shared boat: the other crew member is shoved overboard (both must be in FIGHT mode). They splash about for
   * a few seconds (nothing is lost) and then are back on their own boat; the one who shoved keeps the boat.
   */
  #shoveOffBoat(player, move, kind) {
    const now = this.now();
    const target = player.boatWith;
    if (now < player.stunnedUntil) return { ok: false, error: 'STUNNED' };
    if (player.friendly) return { ok: false, error: 'FRIENDLY' };
    if (target.friendly) return { ok: false, error: 'TARGET_FRIENDLY' };
    if (move.needsAnger && player.anger < ANGER_MAX) return { ok: false, error: 'NOT_ANGRY' };
    if (now < player.moveReadyAt[kind] || now - player.lastAttackAt < MOVE_GAP_MS) return { ok: false, error: 'COOLDOWN' };
    player.moveReadyAt[kind] = now + move.cooldownMs;
    player.lastAttackAt = now;
    player.fightedAt = now;
    if (move.needsAnger) player.anger = 0;
    const map = getMap(player.mapId);
    const boat = player.seat === 'driver' ? player : target;
    const until = now + this.capsizeMs;
    this.#unseat(player);
    const spot = [[28, 0], [-28, 0], [0, 28], [0, -28], [20, 20], [-20, -20]]
      .map(([dx, dy]) => ({ x: boat.x + dx, y: boat.y + dy }))
      .find((p) => p.x >= 0 && p.y >= 0 && p.x <= map.width && p.y <= map.height && !isBlocked(bodyRect(p.x, p.y, map), map));
    if (spot) {
      target.x = spot.x;
      target.y = spot.y;
    }
    target.capsizedUntil = until;
    target.stunnedUntil = until;
    target.moving = false;
    target.budget = BUDGET_MAX;
    target.lastMoveAt = now;
    target.fightedAt = now;
    this.addAnger(target, move.anger ?? 0);
    clearTimeout(target.capsizeTimer);
    target.capsizeTimer = setTimeout(() => {
      if (target.capsizedUntil !== until) return;
      target.capsizedUntil = 0;
      target.stunnedUntil = 0;
      this.onChange(target.room);
    }, this.capsizeMs);
    target.capsizeTimer.unref?.();
    if (player !== boat) { player.x = boat.x; player.y = boat.y; } // the shover stays where the boat is
    this.onCapsize([target], player);
    this.onMoved?.(target);
    this.onChange(player.room);
    return { ok: true, hit: true, shoved: true, target, x: target.x, y: target.y, stunMs: this.capsizeMs, fell: true };
  }

  /** A passenger only chooses where to look (to cast that way); the boat's position is the driver's. */
  #passengerTurn(player, msg) {
    const boat = player.boatWith;
    if (!FACINGS.has(msg?.facing)) return { ok: false, correct: { x: boat.x, y: boat.y } };
    player.facing = msg.facing;
    player.leaning = Boolean(msg.moving); // pressing a direction: shifting weight (the boat does not move)
    player.x = boat.x;
    player.y = boat.y;
    return { ok: true, state: { pid: player.pid, x: boat.x, y: boat.y, facing: player.facing, moving: false, t: msg.t } };
  }

  /** The other players in `player`'s room who are on the same map (the only ones who can see them). */
  neighbours(player) {
    return player.room.players.filter((p) => p !== player && p.mapId === player.mapId && p.connected);
  }

  /** Public snapshot; never includes tokens. */
  view(room) {
    return {
      code: room.code,
      phase: room.phase,
      challenge: room.challenge ? { kind: room.challenge.kind, name: room.challenge.name, unit: room.challenge.unit, remainingMs: Math.max(0, room.challenge.endsAt - this.now()), scores: { ...room.challenge.scores } } : null,
      rush: room.rush ? { spotId: room.rush.spotId, name: room.rush.name, remainingMs: Math.max(0, room.rush.until - this.now()), claimedBy: room.rush.claimedBy } : null,
      boss: room.bossSpot ? { spotId: room.bossSpot.spotId, name: room.bossSpot.name, giant: Boolean(room.bossSpot.giant), remainingMs: Math.max(0, room.bossSpot.until - this.now()) } : null,
      players: room.players.map((p) => ({
        pid: p.pid, name: p.name, slot: p.slot, skin: p.skin, ready: p.ready, connected: p.connected,
        x: p.x, y: p.y, facing: p.facing, moving: p.moving, mapId: p.mapId, anger: p.anger, stats: { ...p.stats }, capsized: this.now() < p.capsizedUntil,
        title: p.titleName ?? null, hat: this.hatOf(p),
        seat: p.seat, boatWith: p.boatWith?.pid ?? null, friendly: p.friendly, swimming: p.swimming,
      })),
    };
  }

  #addPlayer(room, name, profileId) {
    const slot = [0, 1].find((s) => !room.players.some((p) => p.slot === s));
    const player = {
      pid: randomBytes(4).toString('hex'),
      token: randomBytes(16).toString('hex'),
      profileId, // whose coins / fish / gear this player is using (never sent to other clients)
      name: sanitizeName(name),
      slot,
      skin: slot + 1, // one skin per slot
      ready: room.phase === 'playing', // drop-in players join a running game
      connected: true,
      facing: 'down',
      moving: false,
      stats: { caught: 0, biggest: 0, rare: 0, rescues: 0 }, // this session only (the all-time records live in the FishDex)
      lastEmoteAt: -Infinity,
      chatTimes: [],
      friendly: true, // Friendly mode: cannot hit, cannot be hit. Both players must turn it off to fight.
      stunnedUntil: 0,
      anger: 0, // fills when you are hit, robbed or pelted; full = one BIG PUSH
      lastCatch: null, // {itemId, speciesId, at}: the fish just landed, for the few seconds it can be stolen
      stealReadyAt: 0,
      swimming: false, // fell in the water: paddles slowly, climbs out by themselves or is rescued
      swimTimer: null,
      offer: null, // {by, until}: a lifebuoy thrown to this swimmer
      rescueReadyAt: 0,
      moveReadyAt: { slap: 0, push: 0, bonk: 0, big: 0, throw: 0 },
      lastAttackAt: 0, // last time this player attacked (any move)
      fightedAt: -Infinity, // last time this player hit or was hit
      tilt: 0, // a shared boat's lean, kept on its driver
      tiltSent: 0,
      tiltAt: null,
      leaning: false, // a passenger who is pressing a direction key shifts their weight
      capsizedUntil: 0, // the boat flipped: dunked and dizzy until then
      seat: null, // on a shared boat: 'driver' (steers) | 'passenger' (rides, fishes); null = alone
      boatWith: null, // the other player of the boat
      lastStepAt: -Infinity, // when this player's position last changed
      budget: BUDGET_MAX,
      lastMoveAt: this.now(),
      timer: null,
      room,
    };
    this.#spawn(player);
    room.players.push(player);
    return player;
  }

  #spawn(p) {
    // A new game (or a newcomer) starts on the lake at the slot's spawn point.
    const at = spawnPoint(getMap(DEFAULT_MAP_ID), null, p.slot);
    p.mapId = DEFAULT_MAP_ID;
    p.x = at.x;
    p.y = at.y;
    p.facing = 'down';
    p.moving = false;
    p.budget = BUDGET_MAX;
    p.lastMoveAt = this.now();
  }

  #remove(player) {
    clearTimeout(player.timer);
    const room = player.room;
    const i = room.players.indexOf(player);
    if (i === -1) return;
    clearTimeout(player.swimTimer);
    clearTimeout(player.capsizeTimer);
    this.#unseat(player);
    room.players.splice(i, 1);
    this.onRemoved(player);
    if (room.players.length === 0) this.rooms.delete(room.code);
    else this.onChange(room);
  }

  #newCode() {
    for (;;) {
      const code = Array.from({ length: 4 }, () => CODE_ALPHABET[randomBytes(1)[0] % CODE_ALPHABET.length]).join('');
      if (!this.rooms.has(code)) return code;
    }
  }
}

export const normalizeCode = (code) => String(code ?? '').trim().toUpperCase();

export function sanitizeName(name) {
  const clean = String(name ?? '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, NAME_MAX);
  return clean || 'Angler';
}
