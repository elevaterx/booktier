// Autosave. localStorage holds the document; every read and write is defensive because
// storage throws in private windows and silently fills up once covers are inlined as data URLs.

const KEY = 'booktier/v1/doc';

export function save(doc) {
  try {
    localStorage.setItem(KEY, JSON.stringify(doc));
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err && err.name === 'QuotaExceededError'
      ? 'Browser storage is full — export your JSON to keep this list.'
      : 'Could not autosave to browser storage.' };
  }
}

export function load() {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

export function clear() {
  try { localStorage.removeItem(KEY); } catch { /* ignore */ }
}

export function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}
