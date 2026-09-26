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

/**
 * Item id -> the number printed on its cover and beside its title in a Reddit comment.
 *
 * One function, two exporters: the image and the markdown are posted together and a reader uses
 * the number to get from one to the other, so they cannot be allowed to drift. Numbering
 * restarts in each tier — "S+ 1-7" reads cleanly on a cover, where a run to 59 does not.
 *
 * @returns {Map<string, number>}
 */
export function numbering(doc) {
  const groups = groupByTier(doc);
  const order = [...doc.tiers.map((t) => t.id), POOL];
  const out = new Map();
  for (const key of order) {
    (groups.get(key) || []).forEach((item, i) => out.set(item.id, i + 1));
  }
  return out;
}

// The corner label for one item: the value of its render.badgeField field, as short text, or ''
// when the list has no corner label or this item has no such field. Clipped so a long value
// cannot cover the artwork; every caller still escapes it.
export function badgeText(item, render) {
  const key = render && render.badgeField;
  if (!key || !item || !item.fields) return '';
  const value = item.fields[key];
  if (value === undefined || value === null || value === '') return '';
  const text = String(value).trim();
  return text.length > 8 ? `${text.slice(0, 7)}…` : text;
}
