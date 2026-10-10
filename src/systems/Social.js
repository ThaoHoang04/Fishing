/**
 * The friendship and memory side of a profile: counters for the "memory board", friendship points and level,
 * and the titles earned from them. Pure functions over a `meta` object (stored with the profile), driven by
 * src/data/social.json, so a new title or level is data, not code.
 */
export const defaultMeta = () => ({ stats: {}, friendship: 0, titles: [], active: null });

/** A copy of `meta` that is safe to modify (and tolerates old profiles that have none). */
export const cloneMeta = (meta) => ({ ...defaultMeta(), ...JSON.parse(JSON.stringify(meta ?? {})) });

export function levelOf(points, levels) {
  let i = 0;
  while (i + 1 < levels.length && points >= levels[i + 1].at) i++;
  return i;
}

/** Add to a counter. Returns the meta for chaining. */
export function bump(meta, key, n = 1) {
  meta.stats[key] = (meta.stats[key] ?? 0) + n;
  return meta;
}

/** Keep the largest value seen (and, with `tag`, what it was). */
export function best(meta, key, value, tag = null, tagKey = null) {
  if (value > (meta.stats[key] ?? 0)) {
    meta.stats[key] = value;
    if (tagKey) meta.stats[tagKey] = tag;
  }
  return meta;
}

/** Set a counter once (e.g. the date of the first fish). */
export function once(meta, key, value) {
  if (meta.stats[key] === undefined) meta.stats[key] = value;
  return meta;
}

/** Friendship points. Returns {level, levelUp: bool} so the caller can announce a new level. */
export function addFriendship(meta, n, levels) {
  const before = levelOf(meta.friendship, levels);
  meta.friendship += n;
  const level = levelOf(meta.friendship, levels);
  return { level, levelUp: level > before };
}

/** The value a title condition reads: a counter, or the friendship `level`. */
const statValue = (meta, stat, levels) => (stat === 'level' ? levelOf(meta.friendship, levels) : meta.stats[stat] ?? 0);

/** Titles whose condition is now met and that the profile does not have yet (they are added to `meta.titles`). */
export function earnTitles(meta, config) {
  const fresh = config.titles.filter((t) => !meta.titles.includes(t.id) && statValue(meta, t.stat, config.levels) >= t.min);
  for (const t of fresh) meta.titles.push(t.id);
  if (fresh.length > 0 && !meta.active) meta.active = fresh[0].id;
  return fresh;
}

/** What the client shows: levels, progress, every title (earned or not), the memory board. */
export function viewOf(meta, config) {
  const m = cloneMeta(meta); // a profile that never earned anything has {} (or no meta at all)
  const level = levelOf(m.friendship, config.levels);
  const next = config.levels[level + 1] ?? null;
  return {
    friendship: {
      points: m.friendship, level, name: config.levels[level].name,
      next: next ? { name: next.name, at: next.at } : null,
      unlocked: config.levels.slice(0, level + 1).flatMap((l) => l.unlock),
    },
    stats: { ...m.stats },
    titles: config.titles.map((t) => ({ id: t.id, name: t.name, text: t.text, earned: m.titles.includes(t.id) })),
    active: m.active,
    activeName: config.titles.find((t) => t.id === m.active)?.name ?? null,
    memories: config.memories,
  };
}
