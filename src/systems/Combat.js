import { moveFeet, bodyRect, blockedByWater, isBlocked } from './Collision.js';

/**
 * Cartoon fighting on foot: no health, nobody gets hurt. A hit knocks the other player back and leaves them dizzy for a moment.
 * Shared by the server (which decides everything) and the client (which shows the same numbers).
 */
export const MOVES = {
  slap: { label: 'SLAP!', range: 26, knock: 14, stunMs: 500, cooldownMs: 1500, anger: 12 },
  push: { label: 'PUSH!', range: 20, knock: 30, stunMs: 800, cooldownMs: 2500, anger: 20, fall: true },
  bonk: { label: 'BONK!', range: 22, knock: 6, stunMs: 1200, cooldownMs: 3500, anger: 20 },
  // The angry meter's reward: once it is full, one big shove. Needs a full meter and empties it. It never kills the fun: still just knockback and stars.
  big: { label: 'BIG PUSH!', range: 30, knock: 70, stunMs: 1500, cooldownMs: 0, anger: 0, fall: true, needsAnger: true },
  // A thrown fish or piece of junk (see rooms.throwItem): a slow projectile, light knock.
  throw: { label: 'THWACK!', range: 0, knock: 10, stunMs: 400, cooldownMs: 3000, anger: 10 },
};
export const ANGER_MAX = 100;
export const ANGER_STOLEN = 30; // being robbed of a fish makes you this angry
export const THROW = { speed: 140, ttlMs: 900, radius: 12 }; // px/s, how long it flies, how close counts as a hit
export const MOVE_GAP_MS = 400; // minimum time between any two moves of one player
export const MODE_LOCK_MS = 3000; // after fighting you cannot switch Friendly mode on (no hiding mid-brawl)
export const SPLASH_DEPTH = 14; // a push that ends at the water carries the victim this far in
export const FACE_VECTOR = { left: [-1, 0], right: [1, 0], up: [0, -1], down: [0, 1] };

/** Is `target` within reach of `attacker`'s `move`, in front of the way they face? Positions are feet. */
export function canReach(attacker, target, move) {
  const dx = target.x - attacker.x;
  const dy = target.y - attacker.y;
  const dist = Math.hypot(dx, dy);
  if (dist > move.range) return false;
  const [fx, fy] = FACE_VECTOR[attacker.facing] ?? FACE_VECTOR.down;
  return dist < 4 || dx * fx + dy * fy > 0;
}

/**
 * Slide a point `distance` pixels along `facing`, stopping at the first thing in the way (trees, the map edge).
 * With `fall`, running into water is not a stop: the victim goes in (SPLASH_DEPTH px) and `fell` is true.
 */
export function knockedTo(map, from, facing, distance, fall = false) {
  const [fx, fy] = FACE_VECTOR[facing] ?? FACE_VECTOR.down;
  let { x, y } = from;
  for (let moved = 0; moved < distance; moved += 2) {
    const next = moveFeet(x, y, fx * 2, fy * 2, map);
    if (next.x === x && next.y === y) {
      if (!fall || !blockedByWater(bodyRect(x + fx * 2, y + fy * 2, map), map)) break;
      let wx = x;
      let wy = y;
      for (let d = 0; d < SPLASH_DEPTH; d += 2) {
        const swim = moveFeet(wx, wy, fx * 2, fy * 2, map, true);
        if (swim.x === wx && swim.y === wy) break;
        ({ x: wx, y: wy } = swim);
      }
      return { x: wx, y: wy, fell: true };
    }
    ({ x, y } = next);
  }
  return { x, y, fell: false };
}

/** The closest spot to (x, y) where a swimmer can stand on dry ground, searching outwards; null if there is none within `maxR`. */
export function dryNear(map, x, y, maxR = 240) {
  for (let r = 4; r <= maxR; r += 4) {
    const steps = Math.max(8, Math.round(r / 2));
    for (let i = 0; i < steps; i++) {
      const a = (i / steps) * Math.PI * 2;
      const px = Math.round(x + Math.cos(a) * r);
      const py = Math.round(y + Math.sin(a) * r);
      if (!isBlocked(bodyRect(px, py, map), map)) return { x: px, y: py };
    }
  }
  return null;
}

/** The part of a duel ring a fighter's feet may be on (a margin from the ropes). */
export const ringFloor = (ring) => ({ x0: ring.x + 8, y0: ring.y + 10, x1: ring.x + ring.w - 8, y1: ring.y + ring.h - 4 });
export const insideRing = (ring, x, y) => {
  const f = ringFloor(ring);
  return x >= f.x0 && x <= f.x1 && y >= f.y0 && y <= f.y1;
};
export const clampToRing = (ring, x, y) => {
  const f = ringFloor(ring);
  return { x: Math.min(f.x1, Math.max(f.x0, x)), y: Math.min(f.y1, Math.max(f.y0, y)) };
};
