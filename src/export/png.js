// Dependency-free PNG export. No html2canvas: the board is simple enough to draw directly,
// which avoids pulling a large third-party library into a page the user hosts.
//
// Covers are drawn from the local store only. That is deliberate — reading a remote image back
// off a canvas is exactly what browsers refuse, so an exporter that reached for the network
// would fail at the moment of saving. Anything not in the store becomes a labeled placeholder.

import { groupByTier, POOL } from '../core/group.js';
import { bitmapFor } from '../io/covers.js';

const THEME = {
  bg: '#12141a',
  panel: '#1c2029',
  line: '#2a2f3a',
  text: '#e8eaed',
  muted: '#a0a6b0',
  labelText: '#15171c',
  placeholder: '#2a2f3a',
};

const BASE = {
  coverW: 96,
  coverH: 144,
  gap: 8,
  pad: 12,
  rowGap: 8,
  labelW: 84,
  radius: 10,
  boardW: 1120,
  titleSize: 30,
  subSize: 16,
  captionSize: 11,
};

// Gap above the caption, two lines at 1.25 leading, and the descender of the second line.
// The old 2.6x budget was a hair short of that, so a title that wrapped drew its second line
// past the row's rounded background.
const CAPTION_BLOCK = (S) => 4 * (S.coverW / BASE.coverW) + S.captionSize * 1.25 * 2 + S.captionSize * 0.35;

function roundRect(ctx, x, y, w, h, r) {
  const radius = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + w, y, x + w, y + h, radius);
  ctx.arcTo(x + w, y + h, x, y + h, radius);
  ctx.arcTo(x, y + h, x, y, radius);
  ctx.arcTo(x, y, x + w, y, radius);
  ctx.closePath();
}

// Clip a single string to maxWidth, with an ellipsis if anything was cut.
function clip(ctx, text, maxWidth) {
  if (ctx.measureText(text).width <= maxWidth) return text;
  let cut = text;
  while (cut && ctx.measureText(`${cut}…`).width > maxWidth) cut = cut.slice(0, -1);
  return cut ? `${cut}…` : '';
}

function wrapLines(ctx, text, maxWidth, maxLines) {
  const words = String(text || '').split(/\s+/).filter(Boolean);
  const lines = [];
  let line = '';
  let overflowed = false;
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (ctx.measureText(candidate).width <= maxWidth) { line = candidate; continue; }
    if (line) lines.push(line);
    // A word wider than the box — a URL, or a long unhyphenated compound — used to be written
    // out at full width and drawn over the neighbouring column. Every line is clipped now.
    line = ctx.measureText(word).width <= maxWidth ? word : clip(ctx, word, maxWidth);
    if (lines.length === maxLines) { overflowed = true; break; }
  }
  if (!overflowed && lines.length < maxLines && line) lines.push(line);
  if (lines.length > maxLines) lines.length = maxLines;
  const consumed = lines.join(' ');
  if (overflowed || consumed !== words.join(' ')) {
    const last = lines.length ? lines[lines.length - 1] : '';
    if (last) lines[lines.length - 1] = clip(ctx, `${last}…`, maxWidth);
  }
  return lines;
}

// object-fit: cover, by hand.
function drawCover(ctx, bitmap, x, y, w, h, radius) {
  const scale = Math.max(w / bitmap.width, h / bitmap.height);
  const dw = bitmap.width * scale;
  const dh = bitmap.height * scale;
  ctx.save();
  roundRect(ctx, x, y, w, h, radius);
  ctx.clip();
  ctx.drawImage(bitmap, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh);
  ctx.restore();
}

function drawPlaceholder(ctx, item, x, y, w, h, radius, scale) {
  ctx.fillStyle = THEME.placeholder;
  roundRect(ctx, x, y, w, h, radius);
  ctx.fill();
  ctx.fillStyle = THEME.muted;
  ctx.font = `600 ${11 * scale}px system-ui, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  const lines = wrapLines(ctx, item.title, w - 10 * scale, 5);
  const lineHeight = 13 * scale;
  let ty = y + h / 2 - (lines.length * lineHeight) / 2;
  for (const line of lines) { ctx.fillText(line, x + w / 2, ty); ty += lineHeight; }
}

/**
 * Render the document to a PNG blob.
 * `missing` is covers the item HAS but the store does not — the ones "Save covers" can fix.
 * Items with no cover at all come back as `noCover`: telling someone to save a cover that does
 * not exist is a false error, which is what the old single list produced.
 * @returns {Promise<{blob: Blob, width: number, height: number, missing: Array<{title:string,src:string}>, noCover: string[]}>}
 */
export async function toPng(doc, { scale = 2, credit = true } = {}) {
  const S = Object.fromEntries(Object.entries(BASE).map(([k, v]) => [k, v * scale]));
  const groups = groupByTier(doc);
  const rows = doc.tiers.map((tier) => ({ tier, items: groups.get(tier.id) || [] }));
  const pool = groups.get(POOL) || [];
  if (pool.length) rows.push({ tier: { id: POOL, label: 'Unranked', color: '#3a4150' }, items: pool });

  // Resolve every cover up front so layout and drawing never wait on I/O mid-paint.
  const bitmaps = new Map();
  const missing = [];
  const noCover = [];
  for (const item of doc.items) {
    const src = item.image && item.image.src;
    if (!src) { noCover.push(item.title); continue; }
    const bitmap = await bitmapFor(src).catch(() => null);
    if (bitmap) bitmaps.set(item.id, bitmap);
    else missing.push({ title: item.title, src });
  }

  const itemsWidth = S.boardW - S.labelW - S.pad * 2;
  const perRow = Math.max(1, Math.floor((itemsWidth + S.gap) / (S.coverW + S.gap)));
  const measure = document.createElement('canvas').getContext('2d');
  measure.font = `700 ${S.titleSize}px system-ui, sans-serif`;

  const headerH = S.titleSize * 1.4 + (doc.subtitle ? S.subSize * 1.8 : 0) + S.pad * 2;
  const rowHeights = rows.map((row) => {
    const lines = Math.max(1, Math.ceil(row.items.length / perRow));
    const itemH = S.coverH + (doc.render.showLabels ? CAPTION_BLOCK(S) : 0);
    return Math.max(itemH + S.pad * 2, lines * itemH + (lines - 1) * S.gap + S.pad * 2);
  });
  const footerH = (credit || (doc.render && doc.render.caption)) ? S.subSize * 2.4 : S.pad;
  const height = headerH + rowHeights.reduce((a, b) => a + b + S.rowGap, 0) + footerH;

  const canvas = document.createElement('canvas');
  canvas.width = Math.round(S.boardW);
  canvas.height = Math.round(height);
  const ctx = canvas.getContext('2d');

  ctx.fillStyle = THEME.bg;
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.fillStyle = THEME.text;
  ctx.font = `700 ${S.titleSize}px system-ui, sans-serif`;
  ctx.fillText(doc.title || '', S.pad, S.pad);
  if (doc.subtitle) {
    ctx.fillStyle = THEME.muted;
    ctx.font = `${S.subSize}px system-ui, sans-serif`;
    ctx.fillText(doc.subtitle, S.pad, S.pad + S.titleSize * 1.35);
  }

  let y = headerH;
  rows.forEach((row, rowIndex) => {
    const rowH = rowHeights[rowIndex];
    ctx.fillStyle = THEME.panel;
    roundRect(ctx, S.pad, y, S.boardW - S.pad * 2, rowH, S.radius);
    ctx.fill();
    ctx.strokeStyle = THEME.line;
    ctx.lineWidth = Math.max(1, scale * 0.5);
    ctx.stroke();

    ctx.save();
    roundRect(ctx, S.pad, y, S.labelW, rowH, S.radius);
    ctx.clip();
    ctx.fillStyle = row.tier.color;
    ctx.fillRect(S.pad, y, S.labelW, rowH);
    ctx.restore();

    ctx.fillStyle = row.tier.id === POOL ? THEME.text : THEME.labelText;
    ctx.font = `700 ${(row.tier.id === POOL ? 14 : 24) * scale}px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(row.tier.label || ''), S.pad + S.labelW / 2, y + rowH / 2);

    const itemH = S.coverH + (doc.render.showLabels ? CAPTION_BLOCK(S) : 0);
    row.items.forEach((item, i) => {
      const col = i % perRow;
      const line = Math.floor(i / perRow);
      const ix = S.pad + S.labelW + S.pad + col * (S.coverW + S.gap);
      const iy = y + S.pad + line * (itemH + S.gap);
      const bitmap = bitmaps.get(item.id);
      if (bitmap) drawCover(ctx, bitmap, ix, iy, S.coverW, S.coverH, S.radius * 0.6);
      else drawPlaceholder(ctx, item, ix, iy, S.coverW, S.coverH, S.radius * 0.6, scale);
      if (doc.render.showLabels) {
        ctx.fillStyle = THEME.text;
        ctx.font = `${S.captionSize}px system-ui, sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
        const lines = wrapLines(ctx, item.title, S.coverW, 2);
        lines.forEach((l, li) => ctx.fillText(l, ix + S.coverW / 2, iy + S.coverH + 4 * scale + li * S.captionSize * 1.25));
      }
    });

    y += rowH + S.rowGap;
  });

  // The image is what gets reposted, so whatever the user put in `caption` rides along with it.
  const caption = (doc.render && doc.render.caption) || '';
  if (caption || credit) {
    ctx.textBaseline = 'top';
    // Measure the credit first and give the caption what is left, clipped. A handle plus a URL
    // is longer than the footer, and it used to be drawn straight through the credit.
    let creditWidth = 0;
    if (credit) {
      ctx.font = `${S.subSize * 0.75}px system-ui, sans-serif`;
      creditWidth = ctx.measureText('booktier.org').width + S.pad;
    }
    if (caption) {
      ctx.fillStyle = THEME.text;
      ctx.font = `600 ${S.subSize * 0.95}px system-ui, sans-serif`;
      ctx.textAlign = 'left';
      ctx.fillText(clip(ctx, caption, S.boardW - S.pad * 2 - creditWidth), S.pad, y + S.pad * 0.2);
    }
    if (credit) {
      ctx.fillStyle = THEME.muted;
      ctx.font = `${S.subSize * 0.75}px system-ui, sans-serif`;
      ctx.textAlign = caption ? 'right' : 'left';
      ctx.fillText('booktier.org', caption ? S.boardW - S.pad : S.pad, y + S.pad * 0.3);
    }
  }

  for (const bitmap of bitmaps.values()) if (bitmap.close) bitmap.close();

  const blob = await new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('PNG encode failed'))), 'image/png');
  });
  return { blob, width: canvas.width, height: canvas.height, missing, noCover };
}
