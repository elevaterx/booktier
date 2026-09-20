import { createDoc, normalizeItem, newId, safeHref, safeImageSrc, migrate, validate, DEFAULT_RENDER } from '../core/schema.js';
import { applyPlacement, POOL } from '../core/group.js';
import { boardHtml, pageHtml } from '../render/page.js';
import { attachDnD } from './dnd.js';
import { save, load, stash, loadBackup, clearBackup, debounce } from '../io/store.js';
import { dataParam, loadFromUrl, readEmbedded } from '../io/loadUrl.js';
import * as covers from '../io/covers.js';
import { toPng } from '../export/png.js';
import { toMarkdown } from '../export/markdown.js';
import { decodeDoc, fragmentPayload, shareUrl, lengthAdvice } from '../io/share.js';

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

// There is one autosave slot. Anything that replaces the whole document — a shared link, an
// import, a reset — copies the old one aside first, and says so, because otherwise a link
// somebody sends you silently destroys work you cannot get back.
function keepBackup() { return stash(); }

function offerRestore(prefix) {
  const button = $('#btn-restore');
  if (!loadBackup()) { button.hidden = true; return; }
  button.hidden = false;
  status(`${prefix} Your previous list was kept — press “Restore my previous list” to bring it back.`);
}

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
async function hydrateCovers(root = $('#board')) {
  // A map and one round of parallel lookups. This runs on every render — every drag, every
  // arrow key — and the old version did a linear find per image and awaited each store read in
  // turn, so a 60-book list paid 60 serial IndexedDB round trips per move.
  const byId = new Map(doc.items.map((i) => [i.id, i]));
  await Promise.all([...root.querySelectorAll('img.bt-cover')].map(async (img) => {
    const item = byId.get(img.closest('.bt-item').dataset.id);
    if (!item || !item.image) return;
    const src = await covers.displaySrc(item.image.src);
    if (src && src !== img.getAttribute('src')) img.setAttribute('src', src);
  }));
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
  // stats() rejects outright when IndexedDB is unavailable (private windows, blocked storage).
  // Unhandled, that skipped the status line entirely and the button just looked inert.
  const { count, bytes } = await covers.stats().catch(() => ({ count: 0, bytes: 0 }));
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
  if (rejected.length) {
    status(`That ${rejected.join(' and ')} was not usable and was cleared — links must be http(s), `
      + 'covers must be http(s), a data: image, or a path inside this site.', true);
  }
  render();
  if (cover) covers.ensure(cover).then((r) => { if (r.status === 'stored') hydrateCovers(); });
}

function addItems(records) {
  const used = new Set(doc.items.map((i) => i.id));
  for (const r of records) {
    doc.items.push(normalizeItem({ ...r, id: newId(r.title, used), tier: null, pos: doc.items.length }));
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
    const next = /\.html?$/i.test(file.name) ? readEmbedded(text) : migrate(JSON.parse(text));
    if (!next) throw new Error('no tier list data found in that file');
    const check = validate(next);
    if (!check.ok) throw new Error(check.errors.slice(0, 3).join('; '));
    keepBackup();
    doc = next;
    render();
    status(`Loaded ${doc.items.length} items from ${file.name}.`);
  } catch (err) {
    status(`Import failed: ${err.message}`, true);
  }
}

// Clipboard writes get refused often enough (permissions, insecure origins, older browsers)
// that the fallback is part of the feature, not an afterthought.
async function copyField(fieldSel, buttonSel, restoreLabel) {
  const field = $(fieldSel);
  try {
    await navigator.clipboard.writeText(field.value);
    $(buttonSel).textContent = 'Copied';
    setTimeout(() => { $(buttonSel).textContent = restoreLabel; }, 1500);
  } catch {
    field.select();
    status('Clipboard refused — the text is selected, press Ctrl+C.', true);
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
  $('#caption').addEventListener('input', (e) => { doc.render.caption = e.target.value; persist(); });

  $('#btn-export').addEventListener('click', () => $('#exportdialog').showModal());

  $('#btn-restore').addEventListener('click', () => {
    const previous = loadBackup();
    if (!previous) { $('#btn-restore').hidden = true; return; }
    try {
      doc = migrate(previous);
      clearBackup();
      $('#btn-restore').hidden = true;
      $('#title').value = doc.title;
      $('#labels').checked = !!doc.render.showLabels;
      $('#caption').value = doc.render.caption || '';
      render();
      status('Your previous list is back.');
    } catch (err) {
      status(`Could not restore the previous list: ${err.message}`, true);
    }
  });

  // ---------- share link ----------
  async function refreshShare() {
    const out = $('#shareout');
    try {
      // The reading page by default. A link handed to someone else should open something
      // finished, not a workspace — the editor is one button away from there.
      const base = $('#share-edit').checked
        ? location.href.split('#')[0]
        : new URL('../v/', location.href).href;
      const url = await shareUrl(doc, { base, covers: $('#share-covers').checked });
      out.value = url;
      const advice = lengthAdvice(url.length);
      $('#sharelen').textContent = `${url.length.toLocaleString()} characters. ${advice.text}`;
      $('#sharelen').className = `dlg-hint len-${advice.level}`;
    } catch (err) {
      out.value = '';
      $('#sharelen').textContent = `Could not build a link: ${err.message}`;
      $('#sharelen').className = 'dlg-hint len-error';
    }
  }
  $('#btn-share').addEventListener('click', async () => {
    $('#exportdialog').close();
    await refreshShare();
    $('#sharedialog').showModal();
  });
  $('#share-covers').addEventListener('change', refreshShare);
  $('#share-edit').addEventListener('change', refreshShare);
  $('#btn-share-copy').addEventListener('click', () => copyField('#shareout', '#btn-share-copy', 'Copy link'));

  // Reddit renders markdown links, so this is the one share path where the links survive the
  // post itself. Shown in a dialog as well as copied: clipboard writes can be refused, and a
  // silent failure here looks like the button does nothing.
  // The reading-view link that goes in the comment. Built once when the dialog opens rather than
  // on every keystroke of the two checkboxes, because compressing a 59-item list is not free.
  let redditViewUrl = '';

  function refreshMarkdown() {
    const text = toMarkdown(doc, {
      numbers: $('#md-numbers').checked,
      viewUrl: $('#md-link').checked ? redditViewUrl : '',
    });
    $('#mdout').value = text;
    const over = text.length > 10000;
    $('#mdlen').textContent = over
      ? `${text.length.toLocaleString()} characters — Reddit caps a comment at 10,000. Turn off the link, or split the tiers across two comments.`
      : `${text.length.toLocaleString()} characters.`;
    $('#mdlen').className = over ? 'dlg-hint len-error' : 'dlg-hint';
  }

  $('#btn-reddit').addEventListener('click', async () => {
    $('#exportdialog').close();
    redditViewUrl = '';
    if ($('#md-link').checked) {
      try { redditViewUrl = await shareUrl(doc, { base: new URL('../v/', location.href).href }); }
      catch { /* a list too large to encode simply goes without the link */ }
    }
    refreshMarkdown();
    $('#mddialog').showModal();
  });
  $('#md-numbers').addEventListener('change', refreshMarkdown);
  $('#md-link').addEventListener('change', async () => {
    if ($('#md-link').checked && !redditViewUrl) {
      try { redditViewUrl = await shareUrl(doc, { base: new URL('../v/', location.href).href }); }
      catch { /* leave it out */ }
    }
    refreshMarkdown();
  });

  // The image for step 1 is always labeled and numbered — that is the whole point of this flow —
  // without changing what the user's own document or exported page look like.
  $('#btn-reddit-png').addEventListener('click', async () => {
    const button = $('#btn-reddit-png');
    button.disabled = true; button.textContent = 'Rendering…';
    try {
      const { blob, width, height, missing } = await toPng(doc, {
        scale: 2, labels: true, numbers: $('#md-numbers').checked,
      });
      download(`${slug(doc.title)}-reddit.png`, blob, 'image/png');
      status(missing.length
        ? `Image ready at ${width}×${height}. ${missing.length} cover${missing.length === 1 ? '' : 's'} are not in the store and show as titled placeholders — press Save covers and export again for the full set.`
        : `Image ready at ${width}×${height}.`, missing.length > 0);
    } catch (err) {
      status(`Image export failed: ${err.message}`, true);
    } finally {
      button.disabled = false; button.textContent = 'Download image';
    }
  });

  $('#btn-reddit-open').addEventListener('click', () => {
    window.open('https://www.reddit.com/r/litrpg/submit', '_blank', 'noopener,noreferrer');
  });

  // Reddit's submit form takes the title and body as query parameters. Opened in a new tab with
  // noopener, and never submitted for the user — they see the post form and press the button.
  // If Reddit ever stops honouring the parameters, the copy button beside this still works.
  $('#btn-reddit-post').addEventListener('click', () => {
    const url = new URL('https://www.reddit.com/r/litrpg/submit');
    url.searchParams.set('title', doc.title || 'Tier list');
    url.searchParams.set('text', $('#mdout').value);
    if (url.href.length > 8000) {
      status('That post is too long to hand over in a link — copy the markdown and paste it into Reddit instead.', true);
      $('#mdout').select();
      return;
    }
    window.open(url.href, '_blank', 'noopener,noreferrer');
  });
  $('#btn-md-copy').addEventListener('click', () => copyField('#mdout', '#btn-md-copy', 'Copy comment'));

  $('#itemform').addEventListener('submit', (e) => {
    if (e.submitter && e.submitter.value === 'delete') {
      doc.items = doc.items.filter((i) => i.id !== e.currentTarget.dataset.id);
      render();
      return;
    }
    if (e.submitter && e.submitter.value === 'cancel') return;
    saveItemForm(e.currentTarget);
  });

  // One book per set of fields, with the bulk paste kept as a secondary path. Both are read on
  // submit: whichever is filled in gets added, so a pasted batch and a typed entry can go
  // together without the user choosing a mode first.
  $('#addform').addEventListener('submit', (e) => {
    e.preventDefault();
    const form = e.currentTarget;
    const value = (n) => form.querySelector(`[name=${n}]`).value.trim();
    const records = [];

    if (value('title')) {
      records.push({
        title: value('title'),
        byline: value('byline'),
        href: value('href'),
        image: value('cover') ? { src: value('cover') } : null,
      });
    }
    records.push(...parseBulk(value('bulk')));

    if (!records.length) { status('Add a title, or paste a list.', true); return; }
    addItems(records);

    const again = e.submitter && e.submitter.value === 'again';
    form.reset();
    if (again) {
      $('#addcount').textContent = `Added ${records.length}. Keep going.`;
      form.querySelector('[name=title]').focus();
    } else {
      $('#addcount').textContent = '';
      $('#adddialog').close();
    }
  });

  for (const button of document.querySelectorAll('[data-close]')) {
    button.addEventListener('click', () => button.closest('dialog').close());
  }

  $('#btn-add').addEventListener('click', () => {
    $('#addcount').textContent = '';
    $('#adddialog').showModal();
    $('#addform [name=title]').focus();
  });
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
      const { blob, width, height, missing, noCover } = await toPng(doc, { scale: 2 });
      download(`${slug(doc.title)}.png`, blob, 'image/png');
      // Books with no cover at all are drawn as titled placeholders on purpose. Counting those
      // as failures told people to press Save covers, which could never help them.
      const note = missing.length
        ? ` ${missing.length} cover${missing.length === 1 ? '' : 's'} are not in the store and appear as placeholders — use Save covers first.`
        : (noCover.length ? ` ${noCover.length} book${noCover.length === 1 ? '' : 's'} without a cover appear as titled placeholders.` : '');
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
    keepBackup();
    doc = createDoc({ title: 'Untitled tier list' });
    render();
    offerRestore('Cleared.');
  });
}

async function boot() {
  const stored = load();
  const fragment = fragmentPayload();
  const param = dataParam();
  let fromLink = false;

  if (fragment) {
    try {
      doc = await decodeDoc(fragment);
      fromLink = true;
    } catch (err) {
      status(`Could not open that shared list: ${err.message}`, true);
    }
    // Drop the fragment whether or not it loaded. Leaving it in the address bar means every
    // reload silently re-applies the sender's version over whatever the reader has since done.
    try { history.replaceState(null, '', location.pathname + location.search); } catch { /* ignore */ }
  }

  if (!doc && param && param.blocked) {
    status(`This copy of booktier only opens lists hosted on its own site, so it did not load one from ${param.blocked}.`, true);
  } else if (!doc && param) {
    try { doc = await loadFromUrl(param); fromLink = true; }
    catch (err) { status(`Could not load ?data= list: ${err.message}`, true); }
  }

  // The document that arrives from a link is about to be autosaved over the reader's own list,
  // and there is only one slot. Copy theirs aside before render() persists anything.
  const replacedTheirList = fromLink && !!doc && !!stored;
  if (replacedTheirList) keepBackup();

  if (!doc && stored) {
    try { doc = migrate(stored); } catch { doc = null; }
  }
  if (!doc) {
    try {
      const res = await fetch(new URL('../../data/example.json', import.meta.url));
      if (res.ok) doc = migrate(await res.json());
    } catch { /* opened without a server */ }
  }
  if (!doc) doc = createDoc({ title: 'My tier list', render: { ...DEFAULT_RENDER } });
  $('#labels').checked = !!doc.render.showLabels;
  $('#caption').value = doc.render.caption || '';
  bind();
  render();

  if (replacedTheirList) {
    offerRestore(`Opened a shared list — ${doc.items.length} items, yours to edit.`);
  } else if (fromLink) {
    status(`Opened a shared list — ${doc.items.length} items, yours to edit.`);
    $('#btn-restore').hidden = !loadBackup();
  } else {
    $('#btn-restore').hidden = !loadBackup();
  }

  covers.stats().then(({ count, bytes }) => {
    if (count) $('#storeinfo').textContent = `${count} covers stored (${Math.round(bytes / 1024)} KB)`;
  }).catch(() => { $('#storeinfo').textContent = 'cover store unavailable in this browser'; });
}

boot();
