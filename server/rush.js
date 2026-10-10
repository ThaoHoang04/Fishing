/**
 * Fish Rush: "a rare fish splashes at a spot for 10 seconds". Both players race there: whoever CASTS first at that spot
 * gets the splashing fish on their line (a normal reeling fight, it can still get away); the other one is too late and just
 * fishes normally. It starts by itself every few minutes (with the random events on) and needs two players at the lake.
 */
export default class Rush {
  /**
   * @param {{rooms: object, species: object[], spots: string[], config: object, now?: () => number, rng?: () => number,
   *          emitRoom: (room, event, payload) => void, social?: object, schedule?: boolean}} o
   */
  constructor({ rooms, species, spots, config, now = Date.now, rng = Math.random, emitRoom, social = null, schedule = false }) {
    Object.assign(this, { rooms, spots, cfg: config, now, rng, emitRoom, social, schedule });
    this.pool = species.filter((s) => (s.region ?? 'lake') === 'lake' && !s.boss && config.rarities.includes(s.rarity));
  }

  ensureScheduled(room) {
    if (!this.schedule || room.phase !== 'playing' || room.rushPlan) return;
    this.#plan(room, this.cfg.firstMs);
  }

  #plan(room, delay) {
    clearTimeout(room.rushPlan);
    room.rushPlan = setTimeout(() => this.spawn(room), delay);
    room.rushPlan.unref?.();
  }

  /** A rare fish splashes at `spotId` (random if omitted). Two players at the lake, no other rush, not on top of the boss. */
  spawn(room, spotId = this.spots[Math.floor(this.rng() * this.spots.length)], speciesId = this.pool[Math.floor(this.rng() * this.pool.length)]?.id) {
    const here = room.players.filter((p) => p.connected && p.mapId === 'lake');
    const bad = !this.rooms.rooms.has(room.code) || room.phase !== 'playing' || room.rush || here.length < 2 || room.bossSpot?.spotId === spotId || !speciesId;
    if (bad) {
      if (this.schedule && !room.rush && this.rooms.rooms.has(room.code)) this.#plan(room, 30_000); // not now: try again soon
      return false;
    }
    const species = this.pool.find((s) => s.id === speciesId);
    const rush = { spotId, speciesId, name: species.name, rarity: species.rarity, until: this.now() + this.cfg.windowMs, claimedBy: null, timer: null };
    rush.timer = setTimeout(() => this.#end(room, rush), this.cfg.windowMs);
    rush.timer.unref?.();
    room.rush = rush;
    this.emitRoom(room, 'rush:spot', { spotId, name: species.name, rarity: species.rarity, ms: this.cfg.windowMs });
    this.rooms.onChange(room);
    return true;
  }

  /** The fishing session's forced catch: the first cast at the rush spot gets the fish, later casts get nothing special. */
  forced(player, spotId) {
    const rush = player?.room.rush;
    if (!rush || rush.claimedBy || rush.spotId !== spotId || this.now() >= rush.until) return null;
    rush.claimedBy = player.pid;
    this.social?.stat(player, 'rushClaims');
    this.emitRoom(player.room, 'rush:claimed', { spotId, by: player.pid, name: rush.name });
    clearTimeout(rush.timer);
    rush.timer = setTimeout(() => this.#end(player.room, rush), 1500); // the banner lingers a moment, then it is over
    rush.timer.unref?.();
    const s = this.pool.find((x) => x.id === rush.speciesId);
    return { speciesId: s.id, weight: Math.round((s.minWeight + (s.maxWeight - s.minWeight) * this.rng()) * 10) / 10 };
  }

  #end(room, rush) {
    if (room.rush !== rush) return;
    clearTimeout(rush.timer);
    room.rush = null;
    this.emitRoom(room, 'rush:gone', { spotId: rush.spotId, claimedBy: rush.claimedBy });
    this.rooms.onChange(room);
    if (this.schedule && this.rooms.rooms.has(room.code)) {
      const [lo, hi] = this.cfg.everyMs;
      this.#plan(room, lo + this.rng() * (hi - lo));
    }
  }

  cancelFor(player) {
    const room = player.room;
    if (room.rush && room.players.filter((p) => p.connected && p !== player).length < 1) this.#end(room, room.rush);
  }
}
