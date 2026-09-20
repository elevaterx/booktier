// Data model and validation. No DOM access in this module.

export const SCHEMA = 'booktier/v1';

export const DEFAULT_TIERS = [
  { id: 'splus', label: 'S+', color: '#ff7f7f' },
  { id: 's',     label: 'S',  color: '#ffbf7f' },
  { id: 'a',     label: 'A',  color: '#ffdf7f' },
  { id: 'b',     label: 'B',  color: '#ffff7f' },
  { id: 'c',     label: 'C',  color: '#bfff7f' },
  { id: 'd',     label: 'D',  color: '#7fffff' },
];

export const DEFAULT_RENDER = {
  tooltip: 'card',        // 'card' | 'native' | 'none'
  target: '_blank',
  rel: 'noopener noreferrer',
  showLabels: false,
  fieldOrder: [],         // which `fields` keys to show in the hover card, in order
  caption: '',            // printed at the foot of the exported image — the user's own URL or
                          // handle, so the picture points somewhere once it is reposted.
                          // Empty by default: nobody should leak an address they did not choose.
};

let counter = 0;
export function newId(seed) {
  const base = String(seed || 'item')
    .toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '').slice(0, 48) || 'item';
  counter += 1;
  return `${base}-${counter.toString(36)}`;
}

export function createDoc(partial = {}) {
  return {
    schema: SCHEMA,
    title: partial.title || 'Untitled tier list',
    subtitle: partial.subtitle || '',
    tiers: partial.tiers ? partial.tiers.map(normalizeTier) : DEFAULT_TIERS.map(normalizeTier),
    items: (partial.items || []).map(normalizeItem),
    render: { ...DEFAULT_RENDER, ...(partial.render || {}) },
  };
}

function normalizeTier(t, i) {
  return {
    id: String(t.id || `tier-${i}`),
    label: String(t.label ?? ''),
    color: /^#[0-9a-f]{3,8}$/i.test(t.color || '') ? t.color : '#9aa0a6',
  };
}

export function normalizeItem(raw = {}) {
  const title = typeof raw.title === 'string' ? raw.title : '';
  const item = {
    id: raw.id ? String(raw.id) : newId(title),
    tier: raw.tier === null || raw.tier === undefined ? null : String(raw.tier),
    pos: Number.isFinite(raw.pos) ? raw.pos : 0,
    title,
    byline: typeof raw.byline === 'string' ? raw.byline : '',
    href: safeHref(raw.href),
    image: normalizeImage(raw.image),
    note: typeof raw.note === 'string' ? raw.note : '',
    fields: raw.fields && typeof raw.fields === 'object' && !Array.isArray(raw.fields) ? { ...raw.fields } : {},
  };
  return item;
}

function normalizeImage(img) {
  if (!img) return null;
  const raw = typeof img === 'string' ? img : img.src;
  const src = safeImageSrc(raw);
  if (!src) return null;
  const out = { src };
  if (Number.isFinite(img.w)) out.w = img.w;
  if (Number.isFinite(img.h)) out.h = img.h;
  return out;
}

// Only http(s) and data: images are allowed through. Blocks javascript: URLs, which
// matters because item data arrives from imported files and pasted links.
export function safeHref(href) {
  if (typeof href !== 'string' || !href.trim()) return '';
  const value = href.trim();
  try {
    const url = new URL(value, 'https://example.invalid');
    if (url.protocol === 'http:' || url.protocol === 'https:' || url.protocol === 'mailto:') {
      return /^[a-z]+:/i.test(value) ? value : `https://${value.replace(/^\/+/, '')}`;
    }
  } catch { /* fall through */ }
  return '';
}

// An item's image src is attacker-controlled whenever a document is imported or loaded from
// ?data=. Allow only what a cover can be: http(s), an image data URL, or a relative path.
export function safeImageSrc(src) {
  if (typeof src !== 'string' || !src.trim()) return '';
  const value = src.trim();
  if (/^data:/i.test(value)) return /^data:image\/(png|jpe?g|gif|webp|avif);base64,[a-z0-9+/=\s]+$/i.test(value) ? value : '';
  if (/^[a-z][a-z0-9+.-]*:/i.test(value)) {
    try {
      const url = new URL(value);
      return url.protocol === 'https:' || url.protocol === 'http:' ? value : '';
    } catch { return ''; }
  }
  if (value.startsWith('//')) return '';                  // protocol-relative: resolve explicitly instead
  return /^[\w./-]+$/.test(value) ? value : '';           // relative path, no traversal tricks or quotes
}

export function validate(doc) {
  const errors = [];
  if (!doc || typeof doc !== 'object') return { ok: false, errors: ['not an object'] };
  if (typeof doc.schema !== 'string') errors.push('missing schema');
  if (!Array.isArray(doc.tiers) || doc.tiers.length === 0) errors.push('tiers must be a non-empty array');
  if (!Array.isArray(doc.items)) errors.push('items must be an array');
  const tierIds = new Set((doc.tiers || []).map((t) => t && t.id));
  (doc.items || []).forEach((it, i) => {
    if (!it || typeof it !== 'object') { errors.push(`item ${i} is not an object`); return; }
    if (it.tier !== null && it.tier !== undefined && !tierIds.has(String(it.tier))) {
      errors.push(`item ${i} (${it.title || it.id}) references unknown tier "${it.tier}"`);
    }
  });
  return { ok: errors.length === 0, errors };
}

// Version gate. v1 is current; older shapes get lifted here rather than at call sites.
export function migrate(raw) {
  if (!raw || typeof raw !== 'object') throw new Error('not a tier list document');
  if (raw.schema === SCHEMA) return createDoc(raw);
  if (!raw.schema && Array.isArray(raw.tiers)) return createDoc(raw); // tolerate schema-less hand-written files
  throw new Error(`unsupported schema "${raw.schema}"`);
}
