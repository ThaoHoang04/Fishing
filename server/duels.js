import { canReach, knockedTo, insideRing, clampToRing } from '../src/systems/Combat.js';
import { getMap } from '../src/data/maps.js';

/**
 * Optional duels: one player challenges the other, who may accept. Then both have health, and punch, kick, shove and dodge
 * until one runs out (or time does). Nobody dies and nothing is lost: the loser is simply dizzy and stays where they are.
 * The winner gets a small coin prize (a few per day, so it cannot be farmed).
 */
class Duel {
  constructor(a, b, startAt, endsAt, hp) {
    this.a = a;
    this.b = b;
    this.startAt = startAt; // the fight begins (after the countdown)
    this.endsAt = endsAt;
    this.hp = { [a.pid]: hp, [b.pid]: hp };
    this.ready = { [a.pid]: {}, [b.pid]: {} }; // move -> time it can be used again
    this.dodgeUntil = { [a.pid]: 0, [b.pid]: 0 };
    this.timer = null;
    this.ring = null; // the arena the fight is held in (set at the start, if the lake has one)
    this.back = {}; // pid -> where they stood before the duel: they go back there afterwards
  }

  has(player) {
    return player === this.a || player === this.b;
  }

  other(player) {
    return player === this.a ? this.b : this.a;
  }
}

export default class Duels {
  /**
   * @param {{rooms: object, economy: object, config: object, now?: () => number, social?: object,
   *          emit: (player, event, payload) => void, bagChanged: (player) => void}} o
   */
  constructor({ rooms, economy, config, now = Date.now, social = null, emit, bagChanged }) {
    Object.assign(this, { rooms, economy, cfg: config, now, social, emit, bagChanged });
  }

  /** `from` challenges the other player in the room. The offer lasts `acceptMs`. */
  challenge(from) {
    const room = from.room;
    const now = this.now();
    const to = room.players.find((p) => p !== from && p.connected);
    if (room.phase !== 'playing' || !from.connected) return { ok: false, error: 'NOT_PLAYING' };
    if (!to) return { ok: false, error: 'NO_ONE' };
    if (room.duel) return { ok: false, error: 'DUEL_ON' };
    if (room.duelOffer && now < room.duelOffer.until) return { ok: false, error: 'OFFER_PENDING' };
    if (now < (from.duelOfferReadyAt ?? 0)) return { ok: false, error: 'COOLDOWN', ms: from.duelOfferReadyAt - now };
    for (const p of [from, to]) {
      if (getMap(p.mapId).movement !== 'walk' || p.mapId !== from.mapId) return { ok: false, error: 'NOT_HERE' };
      if (p.seat || p.swimming) return { ok: false, error: 'BUSY' };
    }
    from.duelOfferReadyAt = now + this.cfg.offerCooldownMs;
    room.duelOffer = { from: from.pid, to: to.pid, until: now + this.cfg.acceptMs };
    this.emit(to, 'duel:offer', { from: from.pid, ms: this.cfg.acceptMs });
    this.emit(from, 'duel:offered', { to: to.pid, ms: this.cfg.acceptMs });
    return { ok: true };
  }

  /** The challenged player answers. Accepting starts the countdown. */
  respond(player, accept) {
    const room = player.room;
    const offer = room.duelOffer;
    if (!offer || offer.to !== player.pid || this.now() > offer.until) return { ok: false, error: 'NO_OFFER' };
    room.duelOffer = null;
    const challenger = room.players.find((p) => p.pid === offer.from);
    if (!challenger?.connected) return { ok: false, error: 'NO_OFFER' };
    if (!accept) {
      this.emit(challenger, 'duel:declined', { by: player.pid });
      return { ok: true, started: false };
    }
    return { ...this.#start(room, challenger, player), started: true };
  }

  #start(room, a, b) {
    const now = this.now();
    const startAt = now + this.cfg.countdownMs;
    const duel = new Duel(a, b, startAt, startAt + this.cfg.durationMs, this.cfg.hp);
    room.duel = duel;
    const ring = this.cfg.ring;
    if (ring) {
      // Both step into the arena (one at each end) and are put back where they were when it is over.
      duel.ring = ring;
      [a, b].forEach((p, i) => {
        duel.back[p.pid] = { x: p.x, y: p.y, facing: p.facing };
        this.rooms.place(p, ring.spots[i][0], ring.spots[i][1]);
        this.emit(p, 'duel:moved', { x: p.x, y: p.y });
      });
    }
    // Face each other, stand still for the countdown.
    a.facing = a.x <= b.x ? 'right' : 'left';
    b.facing = a.facing === 'right' ? 'left' : 'right';
    for (const p of [a, b]) {
      p.stunnedUntil = startAt;
      p.moving = false;
      p.anger = 0;
    }
    duel.timer = setTimeout(() => this.#end(duel, 'time'), this.cfg.countdownMs + this.cfg.durationMs + 50);
    duel.timer.unref?.();
    for (const p of [a, b]) {
      this.emit(p, 'duel:start', { a: a.pid, b: b.pid, hp: this.cfg.hp, countdownMs: this.cfg.countdownMs, durationMs: this.cfg.durationMs, moves: Object.keys(this.cfg.moves) });
    }
    this.rooms.onChange(room);
    return { ok: true };
  }

  /** A duel move. Hits need reach and facing, like the cartoon moves; a dodge makes you untouchable for a moment. */
  act(player, kind) {
    const duel = player.room.duel;
    if (!duel || !duel.has(player)) return { ok: false, error: 'NO_DUEL' };
    const move = this.cfg.moves[kind];
    if (!move) return { ok: false, error: 'BAD_MOVE' };
    const now = this.now();
    if (now < duel.startAt) return { ok: false, error: 'TOO_EARLY' };
    if (now < player.stunnedUntil) return { ok: false, error: 'STUNNED' };
    if (now < (duel.ready[player.pid][kind] ?? 0)) return { ok: false, error: 'COOLDOWN' };
    duel.ready[player.pid][kind] = now + move.cooldownMs;
    const foe = duel.other(player);
    if (kind === 'dodge') {
      duel.dodgeUntil[player.pid] = now + move.dodgeMs;
      for (const p of [player, foe]) this.emit(p, 'duel:hit', { from: player.pid, to: null, kind, dmg: 0, dodged: false });
      return { ok: true, hit: false };
    }
    if (!canReach(player, foe, move)) return { ok: true, hit: false };
    if (now < duel.dodgeUntil[foe.pid]) {
      for (const p of [player, foe]) this.emit(p, 'duel:hit', { from: player.pid, to: foe.pid, kind, dmg: 0, dodged: true });
      return { ok: true, hit: false, dodged: true };
    }
    let at = knockedTo(getMap(foe.mapId), foe, player.facing, move.knock, false);
    if (duel.ring) at = clampToRing(duel.ring, at.x, at.y); // the ropes hold you in
    foe.x = at.x;
    foe.y = at.y;
    foe.moving = false;
    foe.stunnedUntil = now + move.stunMs;
    duel.hp[foe.pid] = Math.max(0, duel.hp[foe.pid] - move.dmg);
    const event = { from: player.pid, to: foe.pid, kind, dmg: move.dmg, dodged: false, x: at.x, y: at.y, stunMs: move.stunMs, hp: { ...duel.hp } };
    for (const p of [player, foe]) this.emit(p, 'duel:hit', event);
    if (foe.socketId !== undefined) this.emit(foe, 'duel:moved', { x: at.x, y: at.y }); // the victim's screen follows
    if (duel.hp[foe.pid] <= 0) this.#end(duel, 'ko');
    return { ok: true, hit: true };
  }

  #end(duel, reason) {
    const room = duel.a.room;
    if (room.duel !== duel) return;
    clearTimeout(duel.timer);
    room.duel = null;
    const [a, b] = [duel.a, duel.b];
    const ha = duel.hp[a.pid];
    const hb = duel.hp[b.pid];
    const winner = reason === 'cancelled' || ha === hb ? null : ha > hb ? a : b;
    const loser = winner ? duel.other(winner) : null;
    for (const p of [a, b]) p.stunnedUntil = Math.min(p.stunnedUntil, this.now()); // nobody stays frozen
    for (const p of [a, b]) {
      const back = duel.back[p.pid];
      if (!back) continue;
      this.rooms.place(p, back.x, back.y);
      p.facing = back.facing;
      this.emit(p, 'duel:moved', { x: p.x, y: p.y });
    }
    let coins = 0;
    if (winner && reason !== 'cancelled') {
      coins = this.social?.duelPrize(winner, this.cfg.reward) ?? 0;
      if (coins > 0) this.bagChanged(winner);
      this.social?.stat(winner, 'duelsWon');
      for (const p of [a, b]) this.social?.stat(p, 'duels');
      this.social?.together([a, b], 'duel');
    }
    if (loser) loser.stunnedUntil = this.now() + 1200; // the loser sees stars for a moment, then carries on where they are
    const result = { reason, winner: winner?.pid ?? null, hp: { ...duel.hp }, coins };
    for (const p of [a, b]) this.emit(p, 'duel:end', result);
    this.rooms.onChange(room);
  }

  /** A player left or dropped: the duel is off, nothing is awarded. */
  cancelFor(player) {
    const room = player.room;
    if (room.duelOffer && (room.duelOffer.from === player.pid || room.duelOffer.to === player.pid)) room.duelOffer = null;
    if (room.duel?.has(player)) this.#end(room.duel, 'cancelled');
  }
}
