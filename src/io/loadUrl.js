// Load a tier list document from ?data=<url>, so a published list can live as a JSON file
// next to the page. Technique from silverweed/tiers (WTFPL), with the validation it lacked.
//
// Everything this module returns is UNTRUSTED. The URL is attacker-controllable (anyone can
// send someone a link to this editor with their own ?data=), so the document is size-capped,
// content-type checked, schema validated, and run through normalizeItem — which is what strips
// javascript: links and non-image cover sources — before it reaches the renderer.

import { migrate, validate } from '../core/schema.js';

const MAX_BYTES = 2 * 1024 * 1024;
const TIMEOUT_MS = 15000;

export function dataParam(search = window.location.search) {
  const raw = new URLSearchParams(search).get('data');
  if (!raw) return null;
  try {
    const url = new URL(raw, window.location.href);
    const localDev = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && localDev)) return null;
    if (url.username || url.password) return null;      // no credentials smuggled in the URL
    return url.href;
  } catch { return null; }
}

export async function loadFromUrl(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let res;
  try {
    res = await fetch(url, {
      credentials: 'omit',          // never send the viewer's cookies to a third-party host
      referrerPolicy: 'no-referrer',
      redirect: 'follow',
      cache: 'no-store',
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) throw new Error(`fetch failed: ${res.status}`);

  const type = (res.headers.get('content-type') || '').toLowerCase();
  if (type && !type.includes('json') && !type.includes('text/plain')) {
    throw new Error(`expected JSON, got ${type.split(';')[0]}`);
  }
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_BYTES) throw new Error('document too large');

  const text = await res.text();
  if (text.length > MAX_BYTES) throw new Error('document too large');

  const doc = migrate(JSON.parse(text));
  const check = validate(doc);
  if (!check.ok) throw new Error(check.errors.slice(0, 3).join('; '));
  return doc;
}

// Re-import an exported page: the document is embedded in a JSON script tag. Parsed as data —
// the HTML around it is never inserted into the DOM.
export function readEmbedded(htmlText) {
  const match = String(htmlText).match(/<script type="application\/json" id="booktier-data">([\s\S]*?)<\/script>/);
  if (!match) return null;
  if (match[1].length > MAX_BYTES) throw new Error('embedded document too large');
  return migrate(JSON.parse(match[1].replace(/\\u003c/g, '<')));
}
