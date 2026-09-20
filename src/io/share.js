// Share a list as a link. The whole document travels in the URL fragment — never the query
// string — because a fragment is not sent to the server. The host of a booktier copy should not
// end up with a log line holding every visitor's entire reading list; a tool whose pitch is
// "nothing leaves the browser" cannot quietly make an exception for the share button.
//
// Format: #s=<marker><base64url>, marker 'z' for raw-deflate and 'u' for plain UTF-8 JSON on
// browsers without CompressionStream.

import { migrate, validate } from '../core/schema.js';

export const PREFIX = '#s=';
// A fragment longer than this is not a list, it is an attack or a mistake — refuse before
// spending any memory on it.
export const MAX_FRAGMENT_CHARS = 200000;
// And a small fragment can inflate into an arbitrarily large document, so the decompressed side
// is capped as it streams rather than after the fact.
export const MAX_DECODED_BYTES = 1024 * 1024;

const hasCompression = () => typeof CompressionStream === 'function' && typeof DecompressionStream === 'function';

function b64urlEncode(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecode(text) {
  const padded = text.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function deflate(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

// Read the inflating stream chunk by chunk and stop the moment it passes the cap, so a
// decompression bomb costs one chunk rather than all of memory.
async function inflateCapped(bytes, cap) {
  const reader = new Blob([bytes]).stream()
    .pipeThrough(new DecompressionStream('deflate-raw'))
    .getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > cap) { await reader.cancel(); throw new Error('that shared list is too large to open'); }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) { out.set(chunk, at); at += chunk.length; }
  return out;
}

/** Strip what the link does not need. Covers are most of the payload. */
export function slimDoc(doc, { covers = true } = {}) {
  const copy = {
    schema: doc.schema,
    title: doc.title,
    subtitle: doc.subtitle,
    tiers: doc.tiers,
    render: doc.render,
    items: doc.items.map((item) => {
      const out = { id: item.id, tier: item.tier, pos: item.pos, title: item.title };
      if (item.byline) out.byline = item.byline;
      if (item.href) out.href = item.href;
      if (item.note) out.note = item.note;
      if (item.fields && Object.keys(item.fields).length) out.fields = item.fields;
      // A data: cover would blow the URL out on its own — only a real URL is worth carrying.
      if (covers && item.image && item.image.src && !/^data:/i.test(item.image.src)) out.image = item.image;
      return out;
    }),
  };
  return copy;
}

/** @returns {Promise<string>} the fragment payload, marker included. */
export async function encodeDoc(doc, opts = {}) {
  const json = JSON.stringify(slimDoc(doc, opts));
  const bytes = new TextEncoder().encode(json);
  if (!hasCompression()) return `u${b64urlEncode(bytes)}`;
  return `z${b64urlEncode(await deflate(bytes))}`;
}

/** @returns {Promise<object>} a validated document. Throws with a readable message. */
export async function decodeDoc(payload) {
  const text = String(payload || '');
  if (!text) throw new Error('empty share link');
  if (text.length > MAX_FRAGMENT_CHARS) throw new Error('that shared list is too large to open');
  const marker = text[0];
  const body = text.slice(1);
  if (!/^[A-Za-z0-9_-]*$/.test(body)) throw new Error('that share link is damaged');
  let bytes;
  if (marker === 'z') {
    if (!hasCompression()) throw new Error('this browser cannot open compressed share links');
    bytes = await inflateCapped(b64urlDecode(body), MAX_DECODED_BYTES);
  } else if (marker === 'u') {
    bytes = b64urlDecode(body);
    if (bytes.length > MAX_DECODED_BYTES) throw new Error('that shared list is too large to open');
  } else {
    throw new Error('that share link is in a format this copy does not know');
  }
  // Same gate as every other import path: migrate normalizes and re-sanitizes every href,
  // cover and render option, and validate refuses a document that does not hang together.
  const doc = migrate(JSON.parse(new TextDecoder().decode(bytes)));
  const check = validate(doc);
  if (!check.ok) throw new Error(check.errors.slice(0, 3).join('; '));
  return doc;
}

/** The payload from a location hash, or ''. */
export function fragmentPayload(hash) {
  const value = String(hash === undefined ? (typeof location === 'undefined' ? '' : location.hash) : hash);
  return value.startsWith(PREFIX) ? value.slice(PREFIX.length) : '';
}

/** A full shareable URL for this document. */
export async function shareUrl(doc, opts = {}) {
  const base = opts.base || (typeof location === 'undefined' ? 'https://booktier.org/app/' : location.href.split('#')[0]);
  return `${base}${PREFIX}${await encodeDoc(doc, opts)}`;
}

// What to tell the user about a link of this length. Chrome and Firefox handle far more, but a
// link is only useful if it survives the place it gets pasted.
export function lengthAdvice(length) {
  if (length <= 2000) return { level: 'ok', text: 'Short enough for anywhere — chat apps, Reddit comments, email.' };
  if (length <= 8000) return { level: 'ok', text: 'Fine in browsers and on Reddit. Some chat apps cut links near 4,000 characters.' };
  if (length <= 32000) return { level: 'warn', text: 'Long. Browsers will open it, but it may be truncated when pasted into other apps — leave covers out to shorten it.' };
  return { level: 'error', text: 'Too long to rely on. Leave covers out, or export the page and host that instead.' };
}
