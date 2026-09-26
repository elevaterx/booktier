// The renderer. The editor board and the exported page come from the same functions here,
// so what you drag is what you publish.

import { groupByTier, POOL } from '../core/group.js';

export function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function fieldLines(item, render) {
  const keys = render.fieldOrder && render.fieldOrder.length
    ? render.fieldOrder.filter((k) => item.fields[k] !== undefined)
    : Object.keys(item.fields);
  return keys.map((k) => `<span class="bt-field"><b>${escapeHtml(k)}</b> ${escapeHtml(item.fields[k])}</span>`);
}

// The hover card is a sibling element shown by CSS on :hover and :focus-visible.
// It carries no JavaScript so it survives in a saved page with scripting disabled.
//
// It used to be role="presentation", which meant the author, the note and every extra field were
// announced to nobody — a sighted user got them on hover and a screen reader user got the title
// alone. It is referenced with aria-describedby instead: name from the cover, description from
// the card. A node referenced that way is read even while it is visually hidden.
function cardId(item, opts) {
  return `${opts.idPrefix || ''}bt-d-${item.id}`;
}

function cardHtml(item, render, opts = {}) {
  if (render.tooltip !== 'card') return '';
  const lines = fieldLines(item, render);
  return [
    `<span class="bt-card" id="${escapeHtml(cardId(item, opts))}">`,
    `<span class="bt-card-title">${escapeHtml(item.title)}</span>`,
    item.byline ? `<span class="bt-card-byline">${escapeHtml(item.byline)}</span>` : '',
    lines.length ? `<span class="bt-card-fields">${lines.join('')}</span>` : '',
    item.note ? `<span class="bt-card-note">${escapeHtml(item.note)}</span>` : '',
    '</span>',
  ].join('');
}

// Deterministic palette slot from the item's identity, so a cover-less book looks intentional
// and keeps the same color across renders. A class, not an inline style: the landing page has a
// strict CSP and runs no script, so neither style attributes nor CSSOM are available there.
function hueClass(seed) {
  const text = String(seed || '');
  let h = 2166136261;
  for (let i = 0; i < text.length; i += 1) { h ^= text.charCodeAt(i); h = Math.imul(h, 16777619); }
  return `bt-h${(h >>> 0) % 8}`;
}

export function itemHtml(item, render, opts = {}) {
  const label = [item.title, item.byline].filter(Boolean).join(' — ');
  const native = render.tooltip === 'native' ? ` title="${escapeHtml(label)}"` : '';
  // Every cover sits in a titled shell, and the image is layered over it. A cover that 404s or
  // whose host starts refusing hotlinks leaves the title showing instead of a blank rectangle —
  // with no JavaScript, which matters because an exported page and the reading view both run
  // none, so there is no onerror to fall back on. The title is dropped only when captions are
  // already printing it underneath.
  const blankText = render.showLabels ? '' : `<span class="bt-blank-title" aria-hidden="true">${escapeHtml(item.title || '?')}</span>`;
  const img = item.image
    ? `<img class="bt-cover" src="${escapeHtml(item.image.src)}" alt="" loading="lazy" decoding="async" draggable="false">`
    : '';
  const cover = `<span class="bt-shell ${hueClass(item.id || item.title)}" role="img" aria-label="${escapeHtml(label)}">${blankText}${img}</span>`;
  const caption = render.showLabels ? `<span class="bt-label">${escapeHtml(item.title)}</span>` : '';
  const card = cardHtml(item, render, opts);
  const inner = `${cover}${caption}${card}`;
  const describedBy = card ? ` aria-describedby="${escapeHtml(cardId(item, opts))}"` : '';
  const attrs = `class="bt-item" data-id="${escapeHtml(item.id)}"${native}${describedBy}`;

  // An anchor when there is a link, a focusable span when there is not — so keyboard users
  // reach the hover card either way. No reviewed tool does this.
  if (item.href && !opts.editable) {
    return `<a ${attrs} href="${escapeHtml(item.href)}" target="${escapeHtml(render.target)}" rel="${escapeHtml(render.rel)}">${inner}</a>`;
  }
  if (opts.editable) {
    const href = item.href ? ` data-href="${escapeHtml(item.href)}"` : '';
    // Tier nudge buttons: drag is awkward on a phone and Ctrl+arrows do not exist there.
    // tabindex=-1 keeps them out of the tab order — three stops per cover would make keyboard
    // navigation of a long list miserable, and Ctrl+arrows already cover that case.
    const moves = [
      '<span class="bt-moves" aria-hidden="false">',
      `<button type="button" class="bt-move" data-move="up" tabindex="-1" aria-label="Move ${escapeHtml(item.title)} up a tier">▲</button>`,
      `<button type="button" class="bt-move" data-move="down" tabindex="-1" aria-label="Move ${escapeHtml(item.title)} down a tier">▼</button>`,
      '</span>',
    ].join('');
    return `<span ${attrs}${href} tabindex="0" role="button" draggable="false" aria-label="${escapeHtml(label)}">${inner}${moves}</span>`;
  }
  return `<span ${attrs} tabindex="0">${inner}</span>`;
}

export function boardHtml(doc, opts = {}) {
  const groups = groupByTier(doc);
  const rows = doc.tiers.map((tier) => {
    const items = groups.get(tier.id) || [];
    return [
      `<div class="bt-row" data-tier="${escapeHtml(tier.id)}">`,
      // Inline style only for the exported file. The editor gets data-color and applies it
      // through the CSSOM, so it can be served with a CSP that forbids inline styles.
      opts.inlineStyles === false
        ? `<div class="bt-rowlabel" data-color="${escapeHtml(tier.color)}"><span>${escapeHtml(tier.label)}</span></div>`
        : `<div class="bt-rowlabel" style="background:${escapeHtml(tier.color)}"><span>${escapeHtml(tier.label)}</span></div>`,
      `<div class="bt-items" data-tier="${escapeHtml(tier.id)}">${items.map((i) => itemHtml(i, doc.render, opts)).join('')}</div>`,
      '</div>',
    ].join('');
  });
  const pool = groups.get(POOL) || [];
  const poolHtml = opts.editable || pool.length
    ? [
        '<div class="bt-row bt-pool" data-tier="__pool__">',
        '<div class="bt-rowlabel bt-rowlabel-pool"><span>Unranked</span></div>',
        `<div class="bt-items" data-tier="__pool__">${pool.map((i) => itemHtml(i, doc.render, opts)).join('')}</div>`,
        '</div>',
      ].join('')
    : '';
  return `<div class="bt-board">${rows.join('')}${poolHtml}</div>`;
}

export const BOARD_CSS = `
:root{--bt-bg:#12141a;--bt-fg:#e8eaed;--bt-muted:#a0a6b0;--bt-line:#2a2f3a;--bt-card:#1c2029;--bt-cover-w:92px}
@media (prefers-color-scheme:light){:root{--bt-bg:#f7f8fa;--bt-fg:#1a1c20;--bt-muted:#5a6270;--bt-line:#d9dde4;--bt-card:#fff}}
.bt-board{display:flex;flex-direction:column;gap:6px}
.bt-row{display:flex;align-items:stretch;gap:6px;background:var(--bt-card);border:1px solid var(--bt-line);border-radius:10px}
.bt-rowlabel{border-radius:9px 0 0 9px;flex:0 0 76px;display:flex;align-items:center;justify-content:center;color:#15171c;font-weight:700;font-size:20px;padding:8px 4px;text-align:center;word-break:break-word}
.bt-rowlabel-pool{background:transparent;color:var(--bt-muted);font-size:13px;font-weight:600;border-right:1px solid var(--bt-line)}
.bt-items{flex:1;display:flex;flex-wrap:wrap;gap:6px;padding:8px;min-height:calc(var(--bt-cover-w)*1.5 + 8px)}
.bt-item{position:relative;display:block;width:var(--bt-cover-w);text-decoration:none;color:inherit;border-radius:6px;outline-offset:3px}
.bt-item:focus-visible{outline:2px solid #6ea8fe}
.bt-shell{box-sizing:border-box;position:relative;display:flex;align-items:center;justify-content:center;width:var(--bt-cover-w);height:calc(var(--bt-cover-w)*1.5);padding:8px;text-align:center;border-radius:6px;overflow:hidden;background:linear-gradient(145deg,#3b4254,#232838)}
/* transparent, not a grey plate: a cover that fails to load must reveal the title beneath it */
.bt-cover{position:absolute;inset:0;display:block;width:100%;height:100%;object-fit:cover;background:transparent}
.bt-blank-title{font-size:11px;line-height:1.25;font-weight:600;color:#e8eaed;overflow:hidden;display:-webkit-box;-webkit-line-clamp:5;-webkit-box-orient:vertical}
.bt-shell.bt-h0{background:linear-gradient(145deg,#5b3a58,#2a1f33)}
.bt-shell.bt-h1{background:linear-gradient(145deg,#2f4f63,#1b2b3a)}
.bt-shell.bt-h2{background:linear-gradient(145deg,#54492c,#2c2618)}
.bt-shell.bt-h3{background:linear-gradient(145deg,#2d5348,#182f28)}
.bt-shell.bt-h4{background:linear-gradient(145deg,#4a3350,#241a2c)}
.bt-shell.bt-h5{background:linear-gradient(145deg,#5a3b34,#2e1e1a)}
.bt-shell.bt-h6{background:linear-gradient(145deg,#37456a,#1d2338)}
.bt-shell.bt-h7{background:linear-gradient(145deg,#3f5230,#212b19)}
.bt-label{display:block;font-size:11px;line-height:1.25;margin-top:4px;color:var(--bt-fg);overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}
.bt-card{position:absolute;left:50%;bottom:calc(100% + 8px);transform:translateX(-50%) translateY(4px);width:230px;padding:10px 12px;background:var(--bt-card);color:var(--bt-fg);border:1px solid var(--bt-line);border-radius:10px;box-shadow:0 10px 30px rgba(0,0,0,.35);opacity:0;visibility:hidden;transition:opacity .12s ease,transform .12s ease;z-index:20;pointer-events:none;display:flex;flex-direction:column;gap:3px;text-align:left}
.bt-item:hover .bt-card,.bt-item:focus-visible .bt-card{opacity:1;visibility:visible;transform:translateX(-50%) translateY(0)}
.bt-card-title{font-weight:650;font-size:13px;line-height:1.3}
.bt-card-byline{font-size:12px;color:var(--bt-muted)}
.bt-card-fields{display:flex;flex-wrap:wrap;gap:4px 10px;margin-top:4px;font-size:11px;color:var(--bt-muted)}
.bt-field b{font-weight:600;color:var(--bt-fg)}
.bt-card-note{margin-top:4px;font-size:11px;line-height:1.35;color:var(--bt-muted)}
@media (max-width:640px){:root{--bt-cover-w:64px}.bt-rowlabel{flex-basis:52px;font-size:16px}.bt-card{width:min(220px,70vw)}}
@media print{.bt-card{display:none}}
`;

// A standalone page: no scripts, no network dependencies beyond the cover images themselves.
// The source document is embedded so the exported file can be re-imported into the editor.
// opts.links: extra footer links from whoever publishes the page ("Open in the editor",
// "Download JSON"). Plain anchors, so the page stays script-free. They come from the caller, not
// the document, but are still escaped and limited to http(s) and relative paths, so a caller
// passing untrusted input through cannot produce a javascript: link.
function footLink(link) {
  const href = String(link?.href || '').trim();
  if (!href || (/^[a-z][a-z0-9+.-]*:/i.test(href) && !/^https?:/i.test(href))) return '';
  const download = link.download ? ` download="${escapeHtml(link.download)}"` : '';
  return `<a href="${escapeHtml(href)}"${download}>${escapeHtml(link.label || href)}</a>`;
}

export function pageHtml(doc, opts = {}) {
  const parts = (opts.links || []).map(footLink).filter(Boolean);
  if (opts.credit !== false) parts.push('Made with <a href="https://booktier.org">booktier</a>');
  const credit = parts.length ? `<footer class="bt-foot">${parts.join(' · ')}</footer>` : '';
  return `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(doc.title)}</title>
<meta name="description" content="${escapeHtml(doc.subtitle || doc.title)}">
<style>
body{margin:0;padding:24px 16px 40px;background:var(--bt-bg);color:var(--bt-fg);font:15px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
.bt-wrap{max-width:1100px;margin:0 auto}
.bt-head{margin:0 0 4px;font-size:26px;line-height:1.2}
.bt-sub{margin:0 0 20px;color:var(--bt-muted);font-size:14px}
.bt-foot{margin-top:24px;color:var(--bt-muted);font-size:12px}
.bt-foot a{color:inherit}
${BOARD_CSS}
</style>
<div class="bt-wrap">
<h1 class="bt-head">${escapeHtml(doc.title)}</h1>
${doc.subtitle ? `<p class="bt-sub">${escapeHtml(doc.subtitle)}</p>` : ''}
${boardHtml(doc, { editable: false, inlineStyles: true })}
${credit}
</div>
<script type="application/json" id="booktier-data">${JSON.stringify(doc).replace(/</g, '\\u003c')}</script>
</html>
`;
}
