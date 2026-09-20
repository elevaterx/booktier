// Autosave. localStorage holds the document; every read and write is defensive because
// storage throws in private windows and silently fills up once covers are inlined as data URLs.

const KEY = 'booktier/v1/doc';
const BACKUP = 'booktier/v1/doc.previous';

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

// Called before anything replaces the autosaved document wholesale — a shared link, an import,
// a reset. There is one autosave slot, so without this a link someone sends you overwrites your
// own list with no prompt and no way back.
export function stash() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return false;
    localStorage.setItem(BACKUP, raw);
    return true;
  } catch { return false; }
}

export function loadBackup() {
  try {
    const raw = localStorage.getItem(BACKUP);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

export function clearBackup() {
  try { localStorage.removeItem(BACKUP); } catch { /* ignore */ }
}

export function clear() {
  try { localStorage.removeItem(KEY); } catch { /* ignore */ }
}

export function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}
