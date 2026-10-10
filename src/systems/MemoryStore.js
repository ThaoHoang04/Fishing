/**
 * In-memory store implementing the Economy store contract. Used offline (local test mode) and in tests.
 * `persist(snapshot)` is called after every committed change, so a caller can mirror it to localStorage;
 * `snapshot` in the constructor restores a previous state.
 */
export default class MemoryStore {
  constructor({ snapshot = null, persist = () => {} } = {}) {
    this.profiles = new Map();
    this.catches = [];
    this.nextId = 1;
    this.persist = persist;
    this.depth = 0;
    if (snapshot) this.restore(snapshot);
  }

  getProfile(id) {
    const p = this.profiles.get(id);
    return p ? { ...p, owned: [...p.owned], equipped: { ...p.equipped }, meta: JSON.parse(JSON.stringify(p.meta ?? {})) } : null;
  }

  createProfile(p) {
    if (this.profiles.has(p.id)) throw new Error('duplicate profile');
    this.profiles.set(p.id, { ...p, owned: [...p.owned], equipped: { ...p.equipped }, meta: JSON.parse(JSON.stringify(p.meta ?? {})) });
    this.changed();
  }

  saveProfile(p) {
    if (!this.profiles.has(p.id)) throw new Error('unknown profile');
    if (!(p.coin >= 0)) throw new Error('coin must not be negative'); // same guard as the SQL CHECK
    this.profiles.set(p.id, { ...p, owned: [...p.owned], equipped: { ...p.equipped }, meta: JSON.parse(JSON.stringify(p.meta ?? {})) });
    this.changed();
  }

  listCatches(profileId, { unsold = false } = {}) {
    return this.catches.filter((c) => c.profileId === profileId && (!unsold || !c.sold)).map((c) => ({ ...c }));
  }

  catchStats(profileId) {
    const by = new Map();
    for (const c of this.catches) {
      if (c.profileId !== profileId) continue;
      const r = by.get(c.speciesId) ?? { speciesId: c.speciesId, count: 0, biggest: 0, firstAt: c.caughtAt };
      r.count++;
      r.biggest = Math.max(r.biggest, c.weight);
      r.firstAt = Math.min(r.firstAt, c.caughtAt);
      by.set(c.speciesId, r);
    }
    return [...by.values()];
  }

  addCatch(profileId, { speciesId, weight, caughtAt }) {
    const item = { id: this.nextId++, profileId, speciesId, weight, caughtAt, sold: false };
    this.catches.push(item);
    this.changed();
    return { ...item };
  }

  markSold(profileId, ids) {
    let n = 0;
    for (const c of this.catches) {
      if (c.profileId === profileId && !c.sold && ids.includes(c.id)) {
        c.sold = true;
        n++;
      }
    }
    this.changed();
    return n;
  }

  /** Run `fn` atomically: if it throws, every change it made is undone. */
  transaction(fn) {
    if (this.depth > 0) return fn(); // nested: the outer transaction owns commit/rollback
    const backup = this.snapshot();
    this.depth++;
    this.dirty = false;
    try {
      const result = fn();
      this.depth--;
      if (this.dirty) this.persist(this.snapshot());
      return result;
    } catch (err) {
      this.depth--;
      this.restore(backup);
      throw err;
    }
  }

  changed() {
    if (this.depth > 0) this.dirty = true;
    else this.persist(this.snapshot());
  }

  snapshot() {
    return JSON.parse(JSON.stringify({ profiles: [...this.profiles.values()], catches: this.catches, nextId: this.nextId }));
  }

  restore(s) {
    this.profiles = new Map(s.profiles.map((p) => [p.id, p]));
    this.catches = s.catches;
    this.nextId = s.nextId;
  }
}
