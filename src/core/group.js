// Pure placement helpers: flat item list <-> tier-keyed groups.
// Shape borrowed from nathan71370/tierlistrr (MIT) src/lib/board.ts, reimplemented.

export const POOL = '__pool__';

export function groupByTier(doc) {
  const groups = new Map();
  groups.set(POOL, []);
  for (const tier of doc.tiers) groups.set(tier.id, []);
  for (const item of doc.items) {
    const key = item.tier && groups.has(item.tier) ? item.tier : POOL;
    groups.get(key).push(item);
  }
  for (const list of groups.values()) list.sort((a, b) => a.pos - b.pos);
  return groups;
}

// Writes tier + pos back onto every item so the flat list stays the single source of truth.
export function applyPlacement(doc, itemId, tierId, index) {
  const groups = groupByTier(doc);
  const targetKey = tierId === null || tierId === POOL ? POOL : tierId;
  for (const list of groups.values()) {
    const at = list.findIndex((i) => i.id === itemId);
    if (at !== -1) list.splice(at, 1);
  }
  const item = doc.items.find((i) => i.id === itemId);
  if (!item) return doc;
  const target = groups.get(targetKey) || groups.get(POOL);
  const clamped = Math.max(0, Math.min(Number.isFinite(index) ? index : target.length, target.length));
  target.splice(clamped, 0, item);
  for (const [key, list] of groups) {
    list.forEach((it, i) => { it.tier = key === POOL ? null : key; it.pos = i; });
  }
  return doc;
}

export function tierOf(doc, itemId) {
  const item = doc.items.find((i) => i.id === itemId);
  return item ? item.tier : null;
}

export function countsByTier(doc) {
  const groups = groupByTier(doc);
  const out = {};
  for (const [key, list] of groups) out[key] = list.length;
  return out;
}
