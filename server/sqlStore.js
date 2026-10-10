import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import initSqlJs from 'sql.js';

/**
 * SQLite-backed store for the Economy (see src/systems/Economy.js for the contract).
 * Uses sql.js (SQLite compiled to WebAssembly: no native build step). The database lives in memory and is
 * written to `file` after every committed change, via a temp file + rename so a crash never leaves a
 * half-written database. Schema constraints back up the game rules (coin >= 0, an item is sold once).
 */
export async function openSqlStore({ file = null } = {}) {
  const SQL = await initSqlJs();
  const bytes = file && existsSync(file) ? readFileSync(file) : null;
  return new SqlStore(new SQL.Database(bytes), file);
}

class SqlStore {
  constructor(db, file) {
    this.db = db;
    this.file = file;
    this.depth = 0;
    this.dirty = false;
    db.run(`create table if not exists profiles (
      id text primary key,
      token_hash text not null,
      name text not null,
      coin integer not null check (coin >= 0),
      owned text not null,
      equipped text not null,
      created_at integer not null,
      meta text not null default '{}'
    )`);
    // Databases made before the friendship system have no `meta` column yet.
    if (!this.all('pragma table_info(profiles)').some((c) => c.name === 'meta')) db.run("alter table profiles add column meta text not null default '{}'");
    db.run(`create table if not exists catches (
      id integer primary key autoincrement,
      profile_id text not null references profiles(id),
      species_id text not null,
      weight real not null check (weight > 0),
      caught_at integer not null,
      sold integer not null default 0 check (sold in (0, 1))
    )`);
    db.run('create index if not exists idx_catches_profile on catches(profile_id, sold)');
    this.flush();
  }

  // --- reads ---

  all(sql, params = []) {
    const stmt = this.db.prepare(sql);
    try {
      stmt.bind(params);
      const rows = [];
      while (stmt.step()) rows.push(stmt.getAsObject());
      return rows;
    } finally {
      stmt.free(); // export() invalidates prepared statements, so never keep them around
    }
  }

  getProfile(id) {
    const [r] = this.all('select * from profiles where id = ?', [id]);
    return r && { id: r.id, tokenHash: r.token_hash, name: r.name, coin: r.coin, owned: JSON.parse(r.owned), equipped: JSON.parse(r.equipped), createdAt: r.created_at, meta: JSON.parse(r.meta ?? '{}') };
  }

  listCatches(profileId, { unsold = false } = {}) {
    const rows = this.all(`select * from catches where profile_id = ? ${unsold ? 'and sold = 0' : ''} order by id`, [profileId]);
    return rows.map((r) => ({ id: r.id, profileId: r.profile_id, speciesId: r.species_id, weight: r.weight, caughtAt: r.caught_at, sold: r.sold === 1 }));
  }

  catchStats(profileId) {
    return this.all(
      'select species_id, count(*) as n, max(weight) as biggest, min(caught_at) as first_at from catches where profile_id = ? group by species_id',
      [profileId],
    ).map((r) => ({ speciesId: r.species_id, count: r.n, biggest: r.biggest, firstAt: r.first_at }));
  }

  // --- writes ---

  createProfile(p) {
    this.write('insert into profiles (id, token_hash, name, coin, owned, equipped, created_at, meta) values (?, ?, ?, ?, ?, ?, ?, ?)',
      [p.id, p.tokenHash, p.name, p.coin, JSON.stringify(p.owned), JSON.stringify(p.equipped), p.createdAt, JSON.stringify(p.meta ?? {})]);
  }

  saveProfile(p) {
    this.write('update profiles set name = ?, coin = ?, owned = ?, equipped = ?, meta = ? where id = ?',
      [p.name, p.coin, JSON.stringify(p.owned), JSON.stringify(p.equipped), JSON.stringify(p.meta ?? {}), p.id]);
  }

  addCatch(profileId, { speciesId, weight, caughtAt }) {
    this.write('insert into catches (profile_id, species_id, weight, caught_at) values (?, ?, ?, ?)', [profileId, speciesId, weight, caughtAt]);
    const [{ id }] = this.all('select last_insert_rowid() as id');
    return { id, profileId, speciesId, weight, caughtAt, sold: false };
  }

  markSold(profileId, ids) {
    if (ids.length === 0) return 0;
    const marks = ids.map(() => '?').join(',');
    this.write(`update catches set sold = 1 where profile_id = ? and sold = 0 and id in (${marks})`, [profileId, ...ids]);
    return this.db.getRowsModified();
  }

  /** Run `fn` atomically (BEGIN/COMMIT, ROLLBACK if it throws); the file is written once, after COMMIT. */
  transaction(fn) {
    if (this.depth > 0) return fn();
    this.db.run('BEGIN');
    this.depth++;
    this.dirty = false;
    try {
      const result = fn();
      this.db.run('COMMIT');
      this.depth--;
      if (this.dirty) this.flush();
      return result;
    } catch (err) {
      this.depth--;
      this.db.run('ROLLBACK');
      throw err;
    }
  }

  write(sql, params) {
    this.db.run(sql, params);
    if (this.depth > 0) this.dirty = true;
    else this.flush();
  }

  flush() {
    if (!this.file) return;
    mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, Buffer.from(this.db.export()));
    renameSync(tmp, this.file);
  }

  close() {
    this.flush();
    this.db.close();
  }
}
