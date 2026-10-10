import { LAKE_MAP } from '../data/maps.js';

// Pixel-based collision, no physics engine: a map is a handful of rects. A rect is { x, y, w, h }.
// Pure functions of (position, map), so the same logic runs in the browser and on the server.

const overlaps = (a, b) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
const contains = (outer, r) => r.x >= outer.x && r.y >= outer.y && r.x + r.w <= outer.x + outer.w && r.y + r.h <= outer.y + outer.h;
const inside = (r, x, y) => x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;

// Hitboxes, anchored at the sprite's bottom-centre: a person's feet, or a boat's hull.
export const FEET = { w: 8, h: 4 };
export const HULL = { w: 16, h: 8 };
export const feetRect = (x, y) => ({ x: x - FEET.w / 2, y: y - FEET.h, w: FEET.w, h: FEET.h });
export const hullRect = (x, y) => ({ x: x - HULL.w / 2, y: y - HULL.h, w: HULL.w, h: HULL.h });
export const bodyRect = (x, y, map = LAKE_MAP) => (map.movement === 'boat' ? hullRect(x, y) : feetRect(x, y));

/** Open water a bobber can land in. On foot: the lake (the pier is not water). At sea: anywhere that is not land. */
export function isWaterAt(x, y, map = LAKE_MAP) {
  if (x < 0 || y < 0 || x > map.width || y > map.height) return false;
  if (map.movement === 'boat') return !map.land.some((r) => inside(r, x, y)) && !map.solids.some((r) => inside(r, x, y));
  return map.water.some((r) => inside(r, x, y)) && !map.walkable.some((r) => inside(r, x, y));
}

/** On foot, is this hitbox stopped by water (and nothing else)? Used to tell "fell in the lake" from "hit a tree". */
export function blockedByWater(r, map = LAKE_MAP) {
  if (map.movement === 'boat') return false;
  return map.water.some((w) => overlaps(r, w)) && !map.walkable.some((p) => contains(p, r)) && !map.solids.some((s) => overlaps(r, s));
}

/** `swim`: a swimmer is not stopped by water (only by the map edge and solid things). */
export function isBlocked(r, map = LAKE_MAP, swim = false) {
  if (r.x < 0 || r.y < 0 || r.x + r.w > map.width || r.y + r.h > map.height) return true;
  if (map.movement === 'boat') {
    if (map.land.some((l) => overlaps(r, l))) return true; // islands and the pier
  } else if (!swim && map.water.some((w) => overlaps(r, w)) && !map.walkable.some((p) => contains(p, r))) {
    return true; // water blocks, unless the hitbox is fully on the pier
  }
  return map.solids.some((s) => overlaps(r, s));
}

// Move a position by (dx, dy), resolving each axis separately so the mover slides along walls.
export function moveFeet(x, y, dx, dy, map = LAKE_MAP, swim = false) {
  let nx = x;
  let ny = y;
  if (dx !== 0 && !isBlocked(bodyRect(x + dx, y, map), map, swim)) nx = x + dx;
  if (dy !== 0 && !isBlocked(bodyRect(nx, y + dy, map), map, swim)) ny = y + dy;
  return { x: nx, y: ny };
}
