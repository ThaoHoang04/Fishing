/**
 * Random events that happen after a catch, decided on the server:
 *  - Seagull: sometimes a gull swoops for a fish you just landed. Shoo it away at the right moment or lose the fish.
 *  - Chest: a treasure chest you fish up has to be opened by both players together; the coins are split.
 * (Junk and the "fake legendary" tease are rolled inside the fishing session; the lucky spot is part of the shared world clock.)
 */

export class Seagulls {
  /** @param {{economy: object, now: () => number, rng: () => number, emit: (player, event, payload) => void, bagChanged: (player) => void, config: object}} o */
  constructor({ economy, now, rng, emit, bagChanged, config, social = null }) {
    Object.assign(this, { economy, now, rng, emit, bagChanged, cfg: config, social });
  }

  /** A fish was landed and is in the bag. Maybe a gull comes for it. Legendary fish and bosses are never taken. Returns true if it did. */
  maybe(player, item, species) {
    if (!(this.cfg.seagullChance > 0) || !species || species.boss || species.rarity === 'legendary') return false;
    if (player.seagull || this.rng() >= this.cfg.seagullChance) return false;
    const now = this.now();
    const gull = { itemId: item.id, speciesId: item.speciesId, readyAt: now + this.cfg.seagullReadyMs, until: now + this.cfg.seagullWindowMs, timer: null };
    gull.timer = setTimeout(() => this.#take(player, gull), this.cfg.seagullWindowMs + 80);
    gull.timer.unref?.();
    player.seagull = gull;
    player.lastCatch = null; // too busy with the gull for anyone to steal it
    this.emit(player, 'seagull:attack', { speciesId: item.speciesId, readyMs: this.cfg.seagullReadyMs, windowMs: this.cfg.seagullWindowMs });
    return true;
  }

  /** The player tries to chase the gull off. Too early and the gull is not close enough to scare; too late and it has the fish. */
  shoo(player) {
    const gull = player.seagull;
    if (!gull) return { ok: false, error: 'NO_SEAGULL' };
    const now = this.now();
    if (now < gull.readyAt) return { ok: false, error: 'TOO_EARLY' };
    if (now > gull.until) return { ok: false, error: 'TOO_LATE' };
    clearTimeout(gull.timer);
    player.seagull = null;
    this.emit(player, 'seagull:result', { stolen: false, speciesId: gull.speciesId });
    this.social?.stat(player, 'gullsShooed');
    return { ok: true };
  }

  cancelFor(player) {
    clearTimeout(player.seagull?.timer);
    player.seagull = null;
  }

  #take(player, gull) {
    if (player.seagull !== gull) return;
    player.seagull = null;
    const lost = this.economy.discard(player.profileId, gull.itemId); // gone already (sold): nothing to take
    this.emit(player, 'seagull:result', { stolen: lost.ok, speciesId: gull.speciesId });
    if (lost.ok) this.bagChanged(player);
  }
}

export class Chests {
  /** @param {{economy: object, now: () => number, rng: () => number, emitRoom: (room, event, payload) => void, bagChanged: (player) => void, config: object}} o */
  constructor({ economy, now, rng, emitRoom, bagChanged, config, social = null }) {
    Object.assign(this, { economy, now, rng, emitRoom, bagChanged, cfg: config.chest, social });
    this.counter = 0;
  }

  /** A chest was fished up: it appears where the catcher stands, for everyone in the room. A new chest replaces an old one. */
  spawn(player) {
    const room = player.room;
    this.#clear(room);
    const chest = { id: String(++this.counter), mapId: player.mapId, x: player.x, y: player.y, until: this.now() + this.cfg.lifeMs, presses: new Map(), timer: null };
    chest.timer = setTimeout(() => {
      if (room.chest !== chest) return;
      room.chest = null;
      this.emitRoom(room, 'chest:gone', { id: chest.id });
    }, this.cfg.lifeMs);
    chest.timer.unref?.();
    room.chest = chest;
    this.emitRoom(room, 'chest:spawn', { id: chest.id, mapId: chest.mapId, x: chest.x, y: chest.y, lifeMs: this.cfg.lifeMs, range: this.cfg.range, windowMs: this.cfg.openWindowMs });
  }

  /** One player presses "open" next to the chest. When both have pressed within the window it opens and the coins are split. */
  open(player) {
    const room = player.room;
    const chest = room.chest;
    if (!chest) return { ok: false, error: 'NO_CHEST' };
    if (player.mapId !== chest.mapId || Math.hypot(player.x - chest.x, player.y - chest.y) > this.cfg.range) return { ok: false, error: 'TOO_FAR' };
    const now = this.now();
    chest.presses.set(player.pid, now);
    const other = room.players.find((p) => p !== player && p.connected && p.mapId === chest.mapId
      && Math.hypot(p.x - chest.x, p.y - chest.y) <= this.cfg.range && now - (chest.presses.get(p.pid) ?? -Infinity) <= this.cfg.openWindowMs);
    if (!other) return { ok: true, waiting: true, windowMs: this.cfg.openWindowMs };
    const [lo, hi] = this.cfg.coins;
    const total = lo + Math.floor(this.rng() * (hi - lo + 1));
    const each = Math.floor(total / 2);
    this.#clear(room);
    for (const p of [player, other]) this.economy.grant(p.profileId, each);
    this.emitRoom(room, 'chest:opened', { id: chest.id, each, total, by: [player.pid, other.pid] });
    for (const p of [player, other]) this.bagChanged(p);
    for (const p of [player, other]) this.social?.stat(p, 'chestsOpened');
    this.social?.together([player, other], 'chestTogether');
    return { ok: true, opened: true, each };
  }

  cancelRoom(room) {
    this.#clear(room);
  }

  #clear(room) {
    if (!room.chest) return;
    clearTimeout(room.chest.timer);
    room.chest = null;
  }
}
