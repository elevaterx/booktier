// Cover store: fetch a cover once, keep the bytes locally, render from the copy forever.
//
// Why a store rather than a cache: image hosts rotate URLs and can change their sharing policy
// at any time, and PNG export cannot read a remote image the host has not opted in to sharing.
// Once the bytes are here, none of that reaches the user's list again.
//
// Verified 2026-09-20: m.media-amazon.com and www.royalroadcdn.com both serve covers with
// permissive CORS headers, so the fetch path below works for them. Hosts that refuse are
// handled by failing soft — the page still displays the remote image directly, which never
// requires permission; only PNG export degrades.

const DB_NAME = 'booktier';
const DB_VERSION = 1;
const STORE = 'covers';
const MAX_EDGE = 320;          // covers render at ~92-100px; 320 covers retina and print
const MAX_BYTES = 8 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 15000;

let dbPromise = null;
const objectUrls = new Map();

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (!('indexedDB' in window)) { reject(new Error('IndexedDB unavailable')); return; }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'key' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('IndexedDB open failed'));
  });
  return dbPromise;
}

function tx(mode, fn) {
  return openDb().then((db) => new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const store = t.objectStore(STORE);
    let result;
    try { result = fn(store); } catch (err) { reject(err); return; }
    t.oncomplete = () => resolve(result && result.__req ? result.__req.result : result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('transaction aborted'));
  }));
}

const wrap = (req) => ({ __req: req });

// Key on a hash of the source URL: the same cover used in five lists is stored once.
export async function keyFor(url) {
  const bytes = new TextEncoder().encode(String(url));
  if (window.crypto && crypto.subtle) {
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    return [...new Uint8Array(digest)].slice(0, 16).map((b) => b.toString(16).padStart(2, '0')).join('');
  }
  let h = 2166136261;                                  // FNV-1a, only for insecure contexts
  for (const b of bytes) { h ^= b; h = Math.imul(h, 16777619); }
  return `fnv${(h >>> 0).toString(16)}`;
}

// Only fetch what a cover can legitimately be, over a transport that cannot be tampered with.
export function isFetchableCover(url) {
  try {
    const u = new URL(url, window.location.href);
    if (u.protocol === 'data:') return false;          // already inline, nothing to fetch
    if (u.origin === window.location.origin) return true;
    return u.protocol === 'https:';
  } catch { return false; }
}

export async function get(url) {
  const key = await keyFor(url);
  return tx('readonly', (s) => wrap(s.get(key)));
}

export async function has(url) {
  return !!(await get(url));
}

async function put(record) {
  await tx('readwrite', (s) => wrap(s.put(record)));
  return record;
}

export async function remove(url) {
  const key = await keyFor(url);
  revoke(url);
  await tx('readwrite', (s) => wrap(s.delete(key)));
}

// Decode via <img crossOrigin> rather than fetch(): it is the same permission check, and it
// hands back a decoded image ready to downscale in one step.
function loadCorsImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.referrerPolicy = 'no-referrer';
    img.decoding = 'async';
    const timer = setTimeout(() => { img.src = ''; reject(new Error('timed out')); }, FETCH_TIMEOUT_MS);
    img.onload = () => { clearTimeout(timer); resolve(img); };
    img.onerror = () => {
      clearTimeout(timer);
      reject(new Error('host refused sharing, or the image is missing'));
    };
    img.src = url;
  });
}

function downscale(img) {
  const scale = Math.min(1, MAX_EDGE / Math.max(img.naturalWidth, img.naturalHeight));
  const w = Math.max(1, Math.round(img.naturalWidth * scale));
  const h = Math.max(1, Math.round(img.naturalHeight * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, 0, 0, w, h);
  return new Promise((resolve, reject) => {
    // toBlob throws on a tainted canvas — which is the whole failure mode this store removes.
    try {
      canvas.toBlob((blob) => (blob ? resolve({ blob, w, h }) : reject(new Error('encode failed'))), 'image/webp', 0.85);
    } catch (err) { reject(new Error('image could not be read back (cross-origin restriction)')); }
  });
}

/**
 * Ensure a cover is in the store. Returns a status rather than throwing, because a cover that
 * cannot be stored is a degraded list, not a broken one.
 * @returns {Promise<{status:'cached'|'stored'|'skipped'|'failed', reason?:string, bytes?:number}>}
 */
export async function ensure(url, { force = false } = {}) {
  if (!url) return { status: 'skipped', reason: 'no cover' };
  if (!isFetchableCover(url)) return { status: 'skipped', reason: 'not an https cover URL' };
  try {
    if (!force) {
      const existing = await get(url);
      if (existing) return { status: 'cached', bytes: existing.blob.size };
    }
    const img = await loadCorsImage(url);
    const { blob, w, h } = await downscale(img);
    if (blob.size > MAX_BYTES) return { status: 'failed', reason: 'cover too large' };
    await put({ key: await keyFor(url), src: url, blob, w, h, type: blob.type, fetchedAt: Date.now() });
    revoke(url);
    return { status: 'stored', bytes: blob.size };
  } catch (err) {
    return { status: 'failed', reason: err.message };
  }
}

export async function ensureAll(doc, { onProgress, force = false } = {}) {
  const urls = [...new Set(doc.items.map((i) => i.image && i.image.src).filter(Boolean))];
  const summary = { stored: 0, cached: 0, skipped: 0, failed: 0, failures: [] };
  for (let i = 0; i < urls.length; i += 1) {
    const res = await ensure(urls[i], { force });
    summary[res.status] += 1;
    if (res.status === 'failed') summary.failures.push({ url: urls[i], reason: res.reason });
    if (onProgress) onProgress(i + 1, urls.length, res);
  }
  return summary;
}

// A blob: URL for display. Falls back to the original URL, which needs no permission to show.
export async function displaySrc(url) {
  if (!url) return '';
  if (objectUrls.has(url)) return objectUrls.get(url);
  const record = await get(url).catch(() => null);
  if (!record) return url;
  const objectUrl = URL.createObjectURL(record.blob);
  objectUrls.set(url, objectUrl);
  return objectUrl;
}

function revoke(url) {
  const existing = objectUrls.get(url);
  if (existing) { URL.revokeObjectURL(existing); objectUrls.delete(url); }
}

export function revokeAll() {
  for (const url of [...objectUrls.keys()]) revoke(url);
}

export async function bitmapFor(url) {
  const record = await get(url).catch(() => null);
  if (!record) return null;
  if ('createImageBitmap' in window) return createImageBitmap(record.blob);
  return null;
}

export async function dataUrlFor(url) {
  const record = await get(url).catch(() => null);
  if (!record) return null;
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => resolve(null);
    reader.readAsDataURL(record.blob);
  });
}

export async function stats() {
  const records = await tx('readonly', (s) => wrap(s.getAll()));
  const bytes = (records || []).reduce((sum, r) => sum + (r.blob ? r.blob.size : 0), 0);
  const oldest = (records || []).reduce((min, r) => Math.min(min, r.fetchedAt || Infinity), Infinity);
  return { count: (records || []).length, bytes, oldest: Number.isFinite(oldest) ? oldest : null };
}

export async function clearAll() {
  revokeAll();
  await tx('readwrite', (s) => wrap(s.clear()));
}
