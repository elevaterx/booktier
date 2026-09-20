// Writes src/render/board.css from BOARD_CSS in src/render/page.js.
//
// The exported page inlines its styles (it has to be one file). The editor links this generated
// stylesheet instead, so the app can be served with a Content-Security-Policy that forbids
// inline styles. tools/smoke.mjs fails if the two ever drift.
import { writeFileSync, readFileSync } from 'node:fs';
import { BOARD_CSS } from '../src/render/page.js';

const header = '/* GENERATED from src/render/page.js (BOARD_CSS) by tools/build-css.mjs. Do not edit. */\n';
const path = new URL('../src/render/board.css', import.meta.url);
const next = header + BOARD_CSS;
const current = (() => { try { return readFileSync(path, 'utf8'); } catch { return null; } })();

if (process.argv.includes('--check')) {
  if (current !== next) { console.error('board.css is stale — run: node tools/build-css.mjs'); process.exit(1); }
  console.log('board.css matches BOARD_CSS');
} else {
  writeFileSync(path, next);
  console.log(`wrote src/render/board.css (${next.length} bytes)`);
}
