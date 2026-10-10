// Fishing constants and pure helpers shared by the client and the server.
export const FISHING = {
  BITE_MIN_MS: 3000,
  BITE_MAX_MS: 10000,
  HOOK_MIN_MS: 1000, // how long the player has to react once the fish bites
  HOOK_MAX_MS: 1500,
  HOOK_SLACK_MS: 300, // server-side grace for network latency on top of the hook window
  HOOKED_TTL_MS: 60000, // a hooked session that is never finished is dropped after this
  CAST_MIN_PX: 24,
  CAST_MAX_PX: 72,
  SPOT_RADIUS: 20, // player feet -> spot standing point
  SPOT_TOLERANCE: 8, // extra slack server-side (position snapshots are throttled)
  CHARGE_MS: 1200, // one sweep of the power meter
  MIN_POWER: 0.05,
  CAST_FLIGHT_MS: 600,
  COOLDOWN_MS: 500, // after a session ends, before the next cast
  // Step 1 of the roll: which rarity bites. Only rarities present in the spot's pool take part, so a
  // shallow spot with no epics simply re-spreads those odds over the rest.
  RARITY_WEIGHT: { common: 70, rare: 22, epic: 7, legendary: 1 },
  COOP_JOIN_MS: 30000, // a hooked co-op boss waits this long for the second player before it slips away
  TRASH_CHANCE: 0, // per cast: junk instead of a fish (the server turns the random events on; 0 keeps the rolls plain)
  CHEST_CHANCE: 0, // per cast: a treasure chest
  FAKE_CHANCE: 0.4, // of the junk catches: it is dressed up as a legendary until it is landed
  WEIGHT_SKEW: 1.7, // weight = min + (max - min) * u^skew: small fish are common, whoppers are rare
};

export const RARITIES = ['common', 'rare', 'epic', 'legendary'];
/** Rare and above trigger the room-wide "rare catch" announcement. */
export const isRareOrBetter = (rarity) => RARITIES.indexOf(rarity) >= RARITIES.indexOf('rare');

export const FACING_VECTOR = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] };

/** Where the bobber lands: straight out from the spot in its facing direction. */
export function landingPoint(spot, power, cfg = FISHING) {
  const [vx, vy] = FACING_VECTOR[spot.facing];
  const dist = cfg.CAST_MIN_PX + (cfg.CAST_MAX_PX - cfg.CAST_MIN_PX) * Math.min(1, Math.max(0, power));
  return { x: spot.x + vx * dist, y: spot.y + vy * dist };
}
