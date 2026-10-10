// Inventory, selling and gear shop rules. Pure logic over a `store`, so the exact same rules run on the
// server (SQLite) and offline in the browser (in-memory / localStorage), and are tested against both.
//
// Every operation is all-or-nothing: it validates first, then changes everything inside one store
// transaction. Coins can never go negative and an item can only be sold once.

import { viewOf } from './Social.js';

export const INVENTORY_SLOTS = 20;
export const DEFAULT_GEAR = { rod: 'rod_basic', line: 'line_basic', bait: 'bait_worm' };
export const DEFAULT_OWNED = Object.values(DEFAULT_GEAR);
export const MAX_IDS_PER_REQUEST = 100;

/** Coins for a fish: price per kg of the species x its weight (at least 1). */
export const salePrice = (species, weight) => Math.max(1, Math.round(species.basePrice * weight));

/**
 * Store contract (synchronous):
 *   getProfile(id) / createProfile(p) / saveProfile(p)       p = {id, tokenHash, name, coin, owned[], equipped{}, createdAt}
 *   listCatches(profileId, {unsold})  addCatch(profileId, {speciesId, weight, caughtAt}) -> item
 *   catchStats(profileId) -> [{speciesId, count, biggest, firstAt}]   over every catch ever made, sold or not
 *   markSold(profileId, ids) -> number    transaction(fn) -> fn()'s result, rolled back if it throws
 */
export default class Economy {
  /** @param {{store: object, species: object[], equipment: object[], now?: () => number, slots?: number}} opts */
  constructor({ store, species, equipment, now = Date.now, slots = INVENTORY_SLOTS, social = null }) {
    this.store = store;
    this.social = social; // friendship/titles config (src/data/social.json): when given, state() carries the memory board
    this.speciesById = new Map(species.map((s) => [s.id, s]));
    this.equipmentById = new Map(equipment.map((e) => [e.id, e]));
    this.equipment = equipment;
    this.now = now;
    this.slots = slots;
  }

  /** What the client needs to draw the inventory, wallet and shop. Never includes the token. */
  state(profileId) {
    const p = this.require(profileId);
    const items = this.store.listCatches(profileId, { unsold: true }).map((c) => ({
      id: c.id,
      speciesId: c.speciesId,
      weight: c.weight,
      caughtAt: c.caughtAt,
      price: salePrice(this.speciesById.get(c.speciesId), c.weight),
    }));
    return {
      coin: p.coin, capacity: this.slots, items, owned: [...p.owned], equipped: { ...p.equipped }, dex: this.dex(profileId),
      ...(this.social ? { social: viewOf(p.meta, this.social) } : {}),
    };
  }

  /**
   * The FishDex: one entry per species ever caught (selling a fish does not forget it), with how many were
   * caught, the personal-best weight and when it was first caught. A species unlocks on its first catch.
   */
  dex(profileId) {
    return Object.fromEntries(this.store.catchStats(profileId).map((r) => [r.speciesId, { count: r.count, biggest: r.biggest, firstAt: r.firstAt }]));
  }

  isFull(profileId) {
    return this.store.listCatches(profileId, { unsold: true }).length >= this.slots;
  }

  /** The equipped rod / line / bait as full equipment records. */
  gear(profileId) {
    const { equipped } = this.require(profileId);
    return {
      rod: this.equipmentById.get(equipped.rod),
      line: this.equipmentById.get(equipped.line),
      bait: this.equipmentById.get(equipped.bait),
    };
  }

  /**
   * Put a landed fish into the inventory. Also reports whether it is a species the player has never caught
   * (`isNew`) or beats their previous best of that species (`record`; a first catch is `isNew`, not `record`).
   */
  addCatch(profileId, { speciesId, weight }) {
    if (!this.speciesById.has(speciesId) || !Number.isFinite(weight) || weight <= 0) return { ok: false, error: 'BAD_CATCH' };
    return this.store.transaction(() => {
      if (this.isFull(profileId)) return { ok: false, error: 'INVENTORY_FULL' };
      const before = this.store.catchStats(profileId).find((r) => r.speciesId === speciesId);
      const item = this.store.addCatch(profileId, { speciesId, weight, caughtAt: this.now() });
      return { ok: true, item, isNew: !before, record: Boolean(before) && weight > before.biggest };
    });
  }

  /**
   * Move one unsold fish from a player's bag to another's: a successful steal. No coins change hands. All or nothing;
   * fails if the fish is gone from the owner's bag or the thief's bag is full.
   */
  steal(fromId, toId, itemId) {
    if (fromId === toId) return { ok: false, error: 'BAD_REQUEST' };
    return this.store.transaction(() => {
      this.require(fromId);
      this.require(toId);
      const fish = this.store.listCatches(fromId, { unsold: true }).find((c) => c.id === itemId);
      if (!fish) return { ok: false, error: 'NOT_FOUND' };
      if (this.isFull(toId)) return { ok: false, error: 'INVENTORY_FULL' };
      this.store.markSold(fromId, [itemId]);
      const item = this.store.addCatch(toId, { speciesId: fish.speciesId, weight: fish.weight, caughtAt: this.now() });
      return { ok: true, item };
    });
  }

  /** Coins from a prize (a treasure chest). */
  grant(profileId, amount) {
    if (!Number.isInteger(amount) || amount <= 0) return { ok: false, error: 'BAD_REQUEST' };
    return this.store.transaction(() => {
      const p = this.require(profileId);
      p.coin += amount;
      this.store.saveProfile(p);
      return { ok: true, coin: p.coin };
    });
  }

  /** Lose one unsold fish without being paid for it (a seagull took it). */
  discard(profileId, itemId) {
    return this.store.transaction(() => {
      this.require(profileId);
      if (!this.store.listCatches(profileId, { unsold: true }).some((c) => c.id === itemId)) return { ok: false, error: 'NOT_FOUND' };
      this.store.markSold(profileId, [itemId]);
      return { ok: true };
    });
  }

  /** Sell the given inventory items. Fails as a whole if any id is not an unsold item of this player. */
  sell(profileId, ids) {
    const clean = this.cleanIds(ids);
    if (!clean) return { ok: false, error: 'BAD_REQUEST' };
    return this.store.transaction(() => {
      const p = this.require(profileId);
      const unsold = new Map(this.store.listCatches(profileId, { unsold: true }).map((c) => [c.id, c]));
      if (clean.length === 0 || clean.some((id) => !unsold.has(id))) return { ok: false, error: 'NOT_FOUND' };
      const earned = clean.reduce((sum, id) => {
        const c = unsold.get(id);
        return sum + salePrice(this.speciesById.get(c.speciesId), c.weight);
      }, 0);
      this.store.markSold(profileId, clean);
      p.coin += earned;
      this.store.saveProfile(p);
      return { ok: true, earned, sold: clean };
    });
  }

  sellAll(profileId) {
    const ids = this.store.listCatches(profileId, { unsold: true }).map((c) => c.id);
    if (ids.length === 0) return { ok: false, error: 'NOTHING_TO_SELL' };
    return this.sell(profileId, ids);
  }

  buy(profileId, equipId) {
    const item = this.equipmentById.get(equipId);
    if (!item) return { ok: false, error: 'NOT_FOUND' };
    return this.store.transaction(() => {
      const p = this.require(profileId);
      if (p.owned.includes(equipId)) return { ok: false, error: 'ALREADY_OWNED' };
      if (p.coin < item.price) return { ok: false, error: 'NOT_ENOUGH_COIN' };
      p.coin -= item.price;
      p.owned.push(equipId);
      this.store.saveProfile(p);
      return { ok: true, price: item.price };
    });
  }

  equip(profileId, equipId) {
    const item = this.equipmentById.get(equipId);
    if (!item) return { ok: false, error: 'NOT_FOUND' };
    return this.store.transaction(() => {
      const p = this.require(profileId);
      if (!p.owned.includes(equipId) && item.price > 0) return { ok: false, error: 'NOT_OWNED' }; // free items (no hat) need no purchase
      p.equipped[item.type] = equipId;
      this.store.saveProfile(p);
      return { ok: true };
    });
  }

  // --- helpers ---

  require(profileId) {
    const p = this.store.getProfile(profileId);
    if (!p) throw new Error(`unknown profile ${profileId}`);
    return p;
  }

  /** Whole-number ids, de-duplicated (selling the same item twice in one request counts once), capped. */
  cleanIds(ids) {
    if (!Array.isArray(ids) || ids.length > MAX_IDS_PER_REQUEST || !ids.every((id) => Number.isInteger(id))) return null;
    return [...new Set(ids)];
  }
}
