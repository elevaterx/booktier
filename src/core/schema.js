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
  badgeField: '',         // a `fields` key whose value is printed in the corner of every cover
                          // (page, editor, image) and after the title in the Reddit post.
                          // Empty = no corner label.
  caption: '',            // printed at the foot of the exported image — the user's own URL or
                          // handle, so the picture points somewhere once it is reposted.
                          // Empty by default: nobody should leak an address they did not choose.
};

let counter = 0;
// `used` is the set of ids already spoken for. Without it the counter restarts at zero on every
// page load, so importing a file and then adding a book by hand can mint an id the document is
// already using — after which find(i => i.id === id) resolves the wrong item for every edit,
// drag and delete.
export function newId(seed, used) {
  const base = String(seed || 'item')
    .toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '').slice(0, 48) || 'item';
  let id;
  do { counter += 1; id = `${base}-${counter.toString(36)}`; } while (used && used.has(id));
  if (used) used.add(id);
  return id;
}

export function createDoc(partial = {}) {
  return {
    schema: SCHEMA,
    title: partial.title || 'Untitled tier list',
    subtitle: partial.subtitle || '',
    tiers: dedupeTiers(partial.tiers ? partial.tiers.map(normalizeTier) : DEFAULT_TIERS.map(normalizeTier)),
    items: dedupeIds((partial.items || []).map(normalizeItem)),
    render: normalizeRender(partial.render),
  };
}

// Two tiers sharing an id make groupByTier hand the same bucket to both rows, so every item in
// that tier renders twice — in the editor, in the exported page and in the image.
function dedupeTiers(tiers) {
  const seen = new Set();
  return tiers.filter((t) => (seen.has(t.id) ? false : (seen.add(t.id), true)));
}

// Ids arrive from the file, so a document can hand us duplicates directly.
function dedupeIds(items) {
  const seen = new Set();
  return items.map((item) => {
    if (!seen.has(item.id)) { seen.add(item.id); return item; }
    return { ...item, id: newId(item.title, seen) };
  });
}

// Render options come out of the same untrusted document as everything else. `rel` is the one
// that bites: an explicit rel="" suppresses the implicit noopener browsers apply to
// target=_blank links, which hands the linked page window.opener on the reader's tab. A shared
// link is the natural delivery mechanism for that, so the value is forced, never merged.
export function normalizeRender(raw) {
  const partial = raw && typeof raw === 'object' ? raw : {};
  const tooltip = ['card', 'native', 'none'].includes(partial.tooltip) ? partial.tooltip : DEFAULT_RENDER.tooltip;
  const target = partial.target === '_self' ? '_self' : '_blank';
  const asked = typeof partial.rel === 'string' ? partial.rel.toLowerCase().split(/\s+/).filter(Boolean) : [];
  const rel = [...new Set(['noopener', 'noreferrer', ...asked.filter((t) => /^[a-z-]+$/.test(t))])].join(' ');
  return {
    ...DEFAULT_RENDER,
    tooltip,
    target,
    rel,
    showLabels: !!partial.showLabels,
    fieldOrder: Array.isArray(partial.fieldOrder) ? partial.fieldOrder.filter((k) => typeof k === 'string') : [],
    caption: typeof partial.caption === 'string' ? partial.caption : '',
    badgeField: typeof partial.badgeField === 'string' ? partial.badgeField.trim().slice(0, 40) : '',
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
    fields: normalizeFields(raw.fields),
  };
  return item;
}

// A field value arrives from an imported document and goes straight into the hover card. An
// object rendered as "[object Object]" and an array as "1,2" — so coerce what has an obvious
// reading and drop what does not.
function normalizeFields(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out = {};
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      out[key] = value;
    } else if (Array.isArray(value)) {
      const flat = value.filter((v) => typeof v === 'string' || typeof v === 'number');
      if (flat.length) out[key] = flat.join(', ');
    }
  }
  return out;
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
  // A relative path. The old \w-only test rejected every ordinary filename with a space, an
  // accent or a ?v= cache-buster — and it never blocked the `..` its comment claimed to, since
  // dots and slashes both passed it.
  //
  // `..` is left alone deliberately. A relative src always resolves on this origin whatever it
  // climbs through, so it is not a boundary anything can cross — and the layout HOSTING.md
  // recommends, an exported list in /lists/ pointing at /covers/, needs it. What is worth
  // refusing is a value that could break out of the attribute it is written into.
  if (/[\\"'<>\u0000-\u001f]/.test(value)) return '';
  return value;
}

export function validate(doc) {
  const errors = [];
  if (!doc || typeof doc !== 'object') return { ok: false, errors: ['not an object'] };
  if (typeof doc.schema !== 'string') errors.push('missing schema');
  if (!Array.isArray(doc.tiers) || doc.tiers.length === 0) errors.push('tiers must be a non-empty array');
  if (!Array.isArray(doc.items)) errors.push('items must be an array');
  const tierIds = new Set((doc.tiers || []).map((t) => t && t.id));
  if (Array.isArray(doc.tiers) && tierIds.size !== doc.tiers.length) errors.push('two tiers share an id');
  const itemIds = new Set((doc.items || []).map((it) => it && it.id));
  if (Array.isArray(doc.items) && itemIds.size !== doc.items.length) errors.push('two items share an id');
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
  if (Array.isArray(raw.tiers) && raw.tiers.some((t) => !t || typeof t !== 'object')) {
    throw new Error('a tier in that document is not an object');
  }
  if (Array.isArray(raw.items) && raw.items.some((i) => i !== null && i !== undefined && typeof i !== 'object')) {
    throw new Error('an item in that document is not an object');
  }
  if (raw.schema === SCHEMA) return createDoc(raw);
  if (!raw.schema && Array.isArray(raw.tiers)) return createDoc(raw); // tolerate schema-less hand-written files
  throw new Error(`unsupported schema "${raw.schema}"`);
}
