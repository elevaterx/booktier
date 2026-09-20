import { createDoc, normalizeItem, newId, safeHref, safeImageSrc, migrate, validate, DEFAULT_RENDER } from '../core/schema.js';
import { applyPlacement, POOL } from '../core/group.js';
import { boardHtml, pageHtml } from '../render/page.js';
import { attachDnD } from './dnd.js';
import { save, load, debounce } from '../io/store.js';
import { dataParam, loadFromUrl, readEmbedded } from '../io/loadUrl.js';
import * as covers from '../io/covers.js';
import { toPng } from '../export/png.js';

const $ = (sel) => document.querySelector(sel);
let doc = null;

const persist = debounce(() => {
  const res = save(doc);
  if (!res.ok) status(res.error, true);
}, 400);

function status(message, isError = false) {
  const el = $('#status');
  el.textContent = message;
  el.classList.toggle('error', isError);
  if (message) setTimeout(() => { if (el.textContent === message) el.textContent = ''; }, isError ? 8000 : 4000);
}

function announce(message) { $('#live').textContent = message; }

function render() {
  $('#title').value = doc.title;
  $('#subtitle').value = doc.subtitle;
  // inlineStyles:false keeps the editor free of style attributes so it can be served under a
  // Content-Security-Policy that forbids inline styles. Colors are applied through the CSSOM.
  $('#board').innerHTML = boardHtml(doc, { editable: true, inlineStyles: false });
  for (const label of $('#board').querySelectorAll('.bt-rowlabel[data-color]')) {
    label.style.backgroundColor = label.dataset.color;
  }
  const total = doc.items.length;
  const ranked = doc.items.filter((i) => i.tier).length;
  $('#counts').textContent = `${total} item${total === 1 ? '' : 's'} · ${ranked} ranked · ${total - ranked} unranked`;
  hydrateCovers();
  persist();
}

// Swap in locally stored covers where we have them. Items we have not stored keep pointing at
// their original URL, which always displays — only PNG export needs the stored copy.
async function hydrateCovers() {
  for (const img of $('#board').querySelectorAll('img.bt-cover')) {
    const item = doc.items.find((i) => i.id === img.closest('.bt-item').dataset.id);
    if (!item || !item.image) continue;
    const src = await covers.displaySrc(item.image.src);
    if (src && src !== img.getAttribute('src')) img.setAttribute('src', src);
  }
}

function move(id, tier, index) {
  applyPlacement(doc, id, tier === POOL ? null : tier, index);
  render();
  const item = doc.items.find((i) => i.id === id);
  const label = tier === POOL ? 'Unranked' : (doc.tiers.find((t) => t.id === tier)?.label || tier);
  announce(`${item.title} moved to ${label}, position ${item.pos + 1}`);
}

// ---------- covers ----------

async function saveCovers({ force = false } = {}) {
  const button = $('#btn-covers');
  button.disabled = true;
  const summary = await covers.ensureAll(doc, {
    force,
    onProgress: (done, total) => { button.textContent = `Saving covers ${done}/${total}`; },
  });
  button.disabled = false;
  button.textContent = 'Save covers';
  await hydrateCovers();
  const { count, bytes } = await covers.stats();
  const parts = [`${summary.stored} saved`, `${summary.cached} already stored`];
  if (summary.failed) parts.push(`${summary.failed} could not be saved`);
  status(`${parts.join(', ')} · store holds ${count} covers (${Math.round(bytes / 1024)} KB)`);
  if (summary.failures.length) {
    announce(`${summary.failures.length} covers could not be saved`);
    console.info('booktier: covers not saved', summary.failures);
  }
}

// ---------- item editing ----------

function openItem(id) {
  const item = doc.items.find((i) => i.id === id);
  if (!item) return;
  const form = $('#itemform');
  form.dataset.id = id;
  form.querySelector('[name=title]').value = item.title;
  form.querySelector('[name=byline]').value = item.byline;
  form.querySelector('[name=href]').value = item.href;
  form.querySelector('[name=cover]').value = item.image ? item.image.src : '';
  form.querySelector('[name=note]').value = item.note;
  form.querySelector('[name=fields]').value = Object.entries(item.fields)
    .map(([k, v]) => `${k}: ${v}`).join('\n');
  $('#itemdialog').showModal();
  form.querySelector('[name=title]').focus();
}

function parseFields(text) {
  const out = {};
  for (const line of String(text).split('\n')) {
    const at = line.indexOf(':');
    if (at === -1) continue;
    const key = line.slice(0, at).trim();
    const value = line.slice(at + 1).trim();
    if (key && value) out[key] = /^-?\d+(\.\d+)?$/.test(value) ? Number(value) : value;
  }
  return out;
}

function saveItemForm(form) {
  const item = doc.items.find((i) => i.id === form.dataset.id);
  if (!item) return;
  const get = (n) => form.querySelector(`[name=${n}]`).value.trim();
  item.title = get('title');
  item.byline = get('byline');
  item.href = safeHref(get('href'));
  const cover = safeImageSrc(get('cover'));
  item.image = cover ? { src: cover } : null;
  item.note = get('note');
  item.fields = parseFields(get('fields'));
  const rejected = [];
  if (get('href') && !item.href) rejected.push('link');
  if (get('cover') && !cover) rejected.push('cover URL');
  if (rejected.length) status(`That ${rejected.join(' and ')} was not a usable http(s) address and was cleared.`, true);
  render();
  if (cover) covers.ensure(cover).then((r) => { if (r.status === 'stored') hydrateCovers(); });
}

function addItems(records) {
  for (const r of records) {
    doc.items.push(normalizeItem({ ...r, id: newId(r.title), tier: null, pos: doc.items.length }));
  }
  render();
  status(`Added ${records.length} item${records.length === 1 ? '' : 's'} to Unranked.`);
  if (records.some((r) => r.image)) saveCovers();
}

// "Title | Author | link | cover url" per line — pipe, tab, or comma separated.
function parseBulk(text) {
  const out = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const parts = line.includes('|') ? line.split('|') : (line.includes('\t') ? line.split('\t') : line.split(','));
    const [title, byline, href, cover] = parts.map((p) => (p || '').trim());
    if (!title) continue;
    out.push({ title, byline: byline || '', href: href || '', image: cover ? { src: cover } : null });
  }
  return out;
}

// ---------- files ----------

function download(filename, data, type) {
  const blob = data instanceof Blob ? data : new Blob([data], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function slug(text) {
  return String(text).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'tierlist';
}

// Optionally bake stored covers into the exported page so it survives the source URLs rotating.
async function docForExport() {
  if (!$('#inline-covers').checked) return doc;
  const copy = JSON.parse(JSON.stringify(doc));
  for (const item of copy.items) {
    if (!item.image) continue;
    const dataUrl = await covers.dataUrlFor(item.image.src);
    if (dataUrl) item.image = { ...item.image, src: dataUrl };
  }
  return copy;
}

async function importFile(file) {
  const text = await file.text();
  try {
    const next = file.name.endsWith('.html') ? readEmbedded(text) : migrate(JSON.parse(text));
    if (!next) throw new Error('no tier list data found in that file');
    const check = validate(next);
    if (!check.ok) throw new Error(check.errors.slice(0, 3).join('; '));
    doc = next;
    render();
    status(`Loaded ${doc.items.length} items from ${file.name}.`);
  } catch (err) {
    status(`Import failed: ${err.message}`, true);
  }
}

// ---------- keyboard placement ----------

function tierOrder() { return [...doc.tiers.map((t) => t.id), POOL]; }

function keyboardMove(id, delta, axis) {
  const item = doc.items.find((i) => i.id === id);
  if (!item) return;
  const order = tierOrder();
  const current = item.tier || POOL;
  if (axis === 'tier') {
    const next = order[Math.max(0, Math.min(order.indexOf(current) + delta, order.length - 1))];
    if (next === current) return;
    move(id, next, 0);
  } else {
    move(id, current, item.pos + delta);
  }
  document.querySelector(`.bt-item[data-id="${CSS.escape(id)}"]`)?.focus();
}

// ---------- wiring ----------

function bind() {
  attachDnD($('#board'), { onDrop: move });

  $('#board').addEventListener('click', (e) => {
    const move = e.target.closest('[data-move]');
    if (move) {
      e.stopPropagation();
      keyboardMove(move.closest('.bt-item').dataset.id, move.dataset.move === 'up' ? -1 : 1, 'tier');
      return;
    }
    const item = e.target.closest('.bt-item');
    if (item) openItem(item.dataset.id);
  });

  $('#board').addEventListener('keydown', (e) => {
    const item = e.target.closest('.bt-item');
    if (!item) return;
    const id = item.dataset.id;
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openItem(id); return; }
    if (!e.ctrlKey && !e.metaKey) return;
    const map = { ArrowUp: ['tier', -1], ArrowDown: ['tier', 1], ArrowLeft: ['pos', -1], ArrowRight: ['pos', 1] };
    const action = map[e.key];
    if (!action) return;
    e.preventDefault();
    keyboardMove(id, action[1], action[0]);
  });

  $('#title').addEventListener('input', (e) => { doc.title = e.target.value; persist(); });
  $('#subtitle').addEventListener('input', (e) => { doc.subtitle = e.target.value; persist(); });
  $('#labels').addEventListener('change', (e) => { doc.render.showLabels = e.target.checked; render(); });

  $('#itemform').addEventListener('submit', (e) => {
    if (e.submitter && e.submitter.value === 'delete') {
      doc.items = doc.items.filter((i) => i.id !== e.currentTarget.dataset.id);
      render();
      return;
    }
    if (e.submitter && e.submitter.value === 'cancel') return;
    saveItemForm(e.currentTarget);
  });

  $('#addform').addEventListener('submit', (e) => {
    e.preventDefault();
    const records = parseBulk(e.currentTarget.querySelector('[name=bulk]').value);
    if (!records.length) { status('Nothing to add — one item per line.', true); return; }
    addItems(records);
    e.currentTarget.reset();
    $('#adddialog').close();
  });

  for (const button of document.querySelectorAll('[data-close]')) {
    button.addEventListener('click', () => button.closest('dialog').close());
  }

  $('#btn-add').addEventListener('click', () => $('#adddialog').showModal());
  $('#btn-import').addEventListener('click', () => $('#file').click());
  $('#file').addEventListener('change', (e) => { if (e.target.files[0]) importFile(e.target.files[0]); e.target.value = ''; });
  $('#btn-covers').addEventListener('click', () => saveCovers());
  $('#btn-json').addEventListener('click', () => download(`${slug(doc.title)}.json`, JSON.stringify(doc, null, 2), 'application/json'));
  $('#btn-html').addEventListener('click', async () => {
    download(`${slug(doc.title)}.html`, pageHtml(await docForExport()), 'text/html');
  });

  $('#btn-png').addEventListener('click', async () => {
    const button = $('#btn-png');
    button.disabled = true; button.textContent = 'Rendering…';
    try {
      const { blob, width, height, missing } = await toPng(doc, { scale: 2 });
      download(`${slug(doc.title)}.png`, blob, 'image/png');
      const note = missing.length
        ? ` ${missing.length} cover${missing.length === 1 ? '' : 's'} not in the store appear as placeholders — use Save covers first.`
        : '';
      status(`Image exported at ${width}×${height}.${note}`, missing.length > 0);
    } catch (err) {
      status(`Image export failed: ${err.message}`, true);
    } finally {
      button.disabled = false; button.textContent = 'Export image';
    }
  });

  // The preview renders the read-only board with the app's own stylesheet rather than loading
  // the exported file in an iframe. An iframe would inherit this page's Content-Security-Policy,
  // and the exported file carries its own styles inline — so under the strict CSP in HOSTING.md
  // the preview would appear unstyled while the downloaded file is fine. Same renderer, same
  // markup, styles from board.css instead of a copy inlined in the file.
  $('#btn-preview').addEventListener('click', () => {
    const body = $('#previewbody');
    body.innerHTML = boardHtml(doc, { editable: false, inlineStyles: false });
    for (const label of body.querySelectorAll('.bt-rowlabel[data-color]')) {
      label.style.backgroundColor = label.dataset.color;
    }
    for (const img of body.querySelectorAll('img.bt-cover')) {
      const src = img.getAttribute('src');
      covers.displaySrc(src).then((local) => { if (local && local !== src) img.setAttribute('src', local); });
    }
    $('#previewdialog').showModal();
  });
  $('#previewdialog').addEventListener('close', () => { $('#previewbody').innerHTML = ''; });
  $('#btn-html-2').addEventListener('click', async () => {
    download(`${slug(doc.title)}.html`, pageHtml(await docForExport()), 'text/html');
  });

  $('#btn-reset').addEventListener('click', () => {
    if (!confirm('Clear this tier list and start over? Saved covers are kept.')) return;
    doc = createDoc({ title: 'Untitled tier list' });
    render();
  });
}

async function boot() {
  const param = dataParam();
  if (param && param.blocked) {
    status(`This copy of booktier only opens lists hosted on its own site, so it did not load one from ${param.blocked}.`, true);
  } else if (param) {
    try { doc = await loadFromUrl(param); status('Loaded a tier list from the ?data= link.'); }
    catch (err) { status(`Could not load ?data= list: ${err.message}`, true); }
  }
  if (!doc) {
    const stored = load();
    if (stored) { try { doc = migrate(stored); } catch { doc = null; } }
  }
  if (!doc) {
    try {
      const res = await fetch(new URL('../../data/example.json', import.meta.url));
      if (res.ok) doc = migrate(await res.json());
    } catch { /* opened without a server */ }
  }
  if (!doc) doc = createDoc({ title: 'My tier list', render: { ...DEFAULT_RENDER } });
  $('#labels').checked = !!doc.render.showLabels;
  bind();
  render();
  covers.stats().then(({ count, bytes }) => {
    if (count) $('#storeinfo').textContent = `${count} covers stored (${Math.round(bytes / 1024)} KB)`;
  }).catch(() => { $('#storeinfo').textContent = 'cover store unavailable in this browser'; });
}

boot();
