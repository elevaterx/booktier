// Reddit markdown export.
//
// Reddit renders markdown links natively, so this is the one share format where the links —
// the whole point of the tool — survive inside the post. No external page to host, and nothing
// for a spam filter to catch.
//
// Per-tier lines rather than a table: a 59-row table is unreadable on Reddit's mobile app,
// where most of the audience is.

import { groupByTier, POOL } from '../core/group.js';

// Only what actually breaks Reddit's syntax in running text. Escaping the full markdown
// character set turns "S+" into "S\\+" and every sentence into a thicket of backslashes —
// Reddit renders that correctly but it reads terribly if anyone views the raw post.
const ESCAPE = /([\\`*_~\[\]|])/g;

function escapeText(value) {
  return String(value == null ? '' : value).replace(ESCAPE, '\\$1');
}

// Parentheses inside a URL break the (…) link syntax; percent-encode just those.
function safeUrl(href) {
  return String(href || '').replace(/\(/g, '%28').replace(/\)/g, '%29');
}

function itemMarkdown(item) {
  const title = escapeText(item.title);
  return item.href ? `[${title}](${safeUrl(item.href)})` : title;
}

/**
 * @param {object} doc
 * @param {{credit?: boolean, showCounts?: boolean, byline?: boolean}} [opts]
 * @returns {string} markdown ready to paste into a Reddit post
 */
export function toMarkdown(doc, opts = {}) {
  const { credit = true, showCounts = true, byline = false } = opts;
  const lines = [];

  if (doc.title) lines.push(`## ${escapeText(doc.title)}`, '');
  if (doc.subtitle) lines.push(escapeText(doc.subtitle), '');

  // groupByTier, not a per-tier filter: an item whose tier id matches no tier — which a
  // hand-edited or cross-version stored document can easily hold — matched neither the tier
  // filter nor the "no tier" one, and disappeared from the post without a word.
  const groups = groupByTier(doc);

  for (const tier of doc.tiers) {
    const items = groups.get(tier.id) || [];
    if (!items.length) continue;
    const label = escapeText(tier.label);
    const count = showCounts ? ` (${items.length})` : '';
    const listed = items
      .map((i) => (byline && i.byline ? `${itemMarkdown(i)} — ${escapeText(i.byline)}` : itemMarkdown(i)))
      .join(', ');
    lines.push(`**${label}**${count} — ${listed}`, '');
  }

  const unranked = groups.get(POOL) || [];
  if (unranked.length) {
    lines.push(`*Unranked (${unranked.length})* — ${unranked.map(itemMarkdown).join(', ')}`, '');
  }

  if (doc.render && doc.render.caption) lines.push(escapeText(doc.render.caption), '');
  if (credit) lines.push('^(made with booktier.org)');

  return lines.join('\n').trim() + '\n';
}
