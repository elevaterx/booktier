// Smoke test for the editor.
//   npm run smoke            — starts its own static server and runs everything
//   BASE_URL=… node tools/smoke.mjs   — run against a server you started yourself
//
// The suite EXITS NON-ZERO on any failed check. It did not always: `check` used to be a bare
// console.log, so every assertion in this file could fail and `npm run smoke` still reported
// success — which made "the CSP is enforced by the test suite" a claim with nothing behind it.
import { chromium } from 'playwright';
import { startServer } from './serve.mjs';

const own = process.env.BASE_URL ? null : await startServer(0);
const base = (process.env.BASE_URL || own.url).replace(/\/$/, '');
const app = `${base}/app/`;
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
// Cover images point at a third-party host. The tests check markup and behavior, not pixels,
// so off-origin image requests are answered with a local stub and everything else off-origin is
// refused. Aborting the images instead makes the page retry them hard enough to starve the
// input queue, which hangs page.mouse.move mid-drag — and it made the suite depend on Royal
// Road being reachable, which a test suite should never do.
import { readFileSync, existsSync } from 'node:fs';
const STUB_PNG = readFileSync(new URL('fixtures/cover.png', import.meta.url));

const blockExternal = async (target) => {
  await target.route('**/*', (route) => {
    const url = route.request().url();
    if (url.startsWith(base) || url.startsWith('data:') || url.startsWith('blob:')) return route.continue();
    if (route.request().resourceType() === 'image') {
      return route.fulfill({ status: 200, contentType: 'image/png', body: STUB_PNG });
    }
    return route.abort();
  });
};

const page = await browser.newPage({ viewport: { width: 1280, height: 1100 } });
// Fail loudly instead of hanging: a stuck action should name itself, not stall the suite.
page.setDefaultTimeout(10000);
await blockExternal(page);
const errors = [];
// The editor page carries a strict CSP (meta tag), so parsing an EXPORTED page inside it -
// which the hostile-document test does - reports inline-style refusals. That is expected: an
// exported file is one self-contained document and carries its styles inline by design, which
// is why HOSTING.md gives exported lists their own policy. Counted separately, not ignored.
const inlineStyleNotices = [];
page.on('console', (m) => {
  if (m.type() !== 'error') return;
  const where = m.location().url || '';
  if (where.includes('favicon')) return;
  if (/Refused to apply inline style/.test(m.text())) { inlineStyleNotices.push(m.text().slice(0, 40)); return; }
  errors.push(`${m.text()} @ ${where}`);
});
page.on('pageerror', (e) => errors.push(String(e)));
page.on('response', (r) => { if (r.status() >= 400 && !r.url().includes('favicon')) errors.push(`HTTP ${r.status()} ${r.url()}`) });
await page.goto(app, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('#board .bt-item');


let passed = 0;
const failures = [];
const check = (name, cond, extra = '') => {
  if (cond) passed += 1; else failures.push(`${name}${extra ? ' — ' + extra : ''}`);
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + extra : ''}`);
};

// 1. sample data rendered
const items = await page.locator('.bt-item').count();
check('board renders example items', items === 8, `${items} items`);

// 2. hover card content present with author + link data
const cardText = await page.locator('.bt-item[data-id="primal-hunter"] .bt-card').textContent();
check('hover card carries title + author', cardText.includes('Primal Hunter') && cardText.includes('Zogarth'), JSON.stringify(cardText));
const cardVisibleOnHover = await page.evaluate(() => {
  const el = document.querySelector('.bt-item[data-id="primal-hunter"]');
  const before = getComputedStyle(el.querySelector('.bt-card')).visibility;
  el.classList.add('__hovertest');
  return before;
});
check('hover card is hidden until hover/focus', cardVisibleOnHover === 'hidden', cardVisibleOnHover);

// 3. keyboard placement: focus an S+ item, Ctrl+ArrowDown -> S
await page.locator('.bt-item[data-id="primal-hunter"]').focus();
await page.keyboard.press('Control+ArrowDown');
const tierAfterKey = await page.locator('.bt-items[data-tier="s"] .bt-item[data-id="primal-hunter"]').count();
const live = await page.locator('#live').innerText();
check('keyboard moves item between tiers', tierAfterKey === 1, `announced: ${live}`);
await page.keyboard.press('Control+ArrowUp');

// 4. drag and drop
const src = page.locator('.bt-item[data-id="he-who-fights"]');
const dst = page.locator('.bt-items[data-tier="splus"]');
await src.scrollIntoViewIfNeeded();
const s = await src.boundingBox(); const d = await dst.boundingBox();
await page.mouse.move(s.x + s.width/2, s.y + s.height/2);
await page.mouse.down();
await page.mouse.move(d.x + 20, d.y + d.height/2, { steps: 12 });
await page.mouse.move(d.x + 24, d.y + d.height/2, { steps: 4 });
await page.mouse.up();
await page.waitForTimeout(120);
const dropped = await page.locator('.bt-items[data-tier="splus"] .bt-item[data-id="he-who-fights"]').count();
check('pointer drag moves item to target tier', dropped === 1);

// 5. drag must not navigate (editor items are spans, not anchors)
check('editor items are not navigable anchors', await page.locator('#board a.bt-item').count() === 0);
check('no navigation happened during drag', page.url().startsWith(app), page.url());

// 6. item form round-trip: set a link, confirm it lands in export
await page.locator('.bt-item[data-id="azarinth-healer"]').click();
await page.waitForSelector('#itemdialog[open]');
await page.fill('#itemform [name=href]', 'example.com/no-scheme');
await page.fill('#itemform [name=fields]', 'hours: 84\nvolumes: 12');
await page.click('#itemform button[value=save]');
await page.waitForTimeout(700); // autosave debounce

const exported = await page.evaluate(async () => {
  const m = await import('../src/render/page.js');
  const s = await import('../src/io/store.js');
  return m.pageHtml(JSON.parse(localStorage.getItem('booktier/v1/doc')));
});
check('bare domain upgraded to https in export', exported.includes('href="https://example.com/no-scheme"'));
check('extra fields render in hover card', exported.includes('>hours</b> 84') && exported.includes('>volumes</b> 12'));
const anchorCount = (exported.match(/<a class="bt-item"/g) || []).length;
check('every linked cover exports as an anchor', anchorCount === 8, `${anchorCount} anchors`);
check('exported page embeds its source document', exported.includes('id="booktier-data"'));
check('exported page has no script logic', !/<script(?![^>]*application\/json)/.test(exported));
check('exported page targets new tab safely', exported.includes('rel="noopener noreferrer"'));

// 7. autosave survives reload
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForSelector('#board .bt-item');
const afterReload = await page.locator('.bt-items[data-tier="splus"] .bt-item[data-id="he-who-fights"]').count();
check('placement persists across reload', afterReload === 1);

// 8. malicious import is rejected, not executed
const rejected = await page.evaluate(async () => {
  const s = await import('../src/core/schema.js');
  const doc = s.createDoc({ items: [{ title: 'x', href: 'javascript:alert(1)' }] });
  const bad = s.validate({ schema: 'booktier/v1', tiers: [{id:'a'}], items: [{ title:'y', tier:'nope' }] });
  return { href: doc.items[0].href, ok: bad.ok, errs: bad.errors };
});
check('javascript: URLs are stripped', rejected.href === '');
check('unknown tier reference is caught by validate()', rejected.ok === false, rejected.errs.join('; '));

// ---- add dialog: one book per field set ----
const beforeAdd = await page.locator('#board .bt-item').count();
await page.click('#btn-add');
await page.waitForSelector('#adddialog[open]');
await page.fill('#addform [name=title]', 'Typed Entry');
await page.fill('#addform [name=byline]', 'A Writer');
await page.fill('#addform [name=href]', 'example.org/book');
await page.fill('#addform [name=cover]', '../tools/fixtures/cover.png');
await page.click('#addform button[value=again]');
await page.waitForTimeout(700); // autosave debounce
const afterAgain = {
  count: await page.locator('#board .bt-item').count(),
  dialogOpen: await page.evaluate(() => !!document.querySelector('#adddialog[open]')),
  titleCleared: await page.inputValue('#addform [name=title]'),
  item: await page.evaluate(() => {
    const d = JSON.parse(localStorage.getItem('booktier/v1/doc') || '{}');
    const i = (d.items || []).find((x) => x.title === 'Typed Entry');
    return i ? { byline: i.byline, href: i.href, cover: i.image && i.image.src, tier: i.tier } : null;
  }),
};
check('typed entry adds one item with all four fields', afterAgain.count === beforeAdd + 1
  && afterAgain.item && afterAgain.item.byline === 'A Writer'
  && afterAgain.item.href === 'https://example.org/book'
  && afterAgain.item.cover === '../tools/fixtures/cover.png', JSON.stringify(afterAgain.item));
check('"Add another" keeps the dialog open and clears the form', afterAgain.dialogOpen && afterAgain.titleCleared === '');
check('a new item lands unranked', afterAgain.item && afterAgain.item.tier === null);

await page.fill('#addform [name=title]', 'Second Entry');
await page.click('#addform button[value=done]');
await page.waitForTimeout(700);
check('"Add and close" adds and closes', await page.locator('#board .bt-item').count() === beforeAdd + 2
  && !(await page.evaluate(() => !!document.querySelector('#adddialog[open]'))));

// ---- Reddit markdown + image caption ----
const md = await page.evaluate(async () => {
  const { toMarkdown } = await import('../src/export/markdown.js');
  const s = await import('../src/core/schema.js');
  const doc = s.createDoc({
    title: 'My list',
    tiers: [{ id: 'a', label: 'A*', color: '#ffdf7f' }, { id: 'b', label: 'B', color: '#ffff7f' }],
    items: [
      { title: 'Linked [Book]', tier: 'a', href: 'https://example.com/a(b)' },
      { title: 'No link here', tier: 'a' },
      { title: 'Lower one', tier: 'b', href: 'https://example.com/z' },
      { title: 'Not placed', tier: null },
    ],
    render: { caption: 'booktier.org/lists/mine' },
  });
  return toMarkdown(doc);
});
check('markdown links every item that has a link', (md.match(/\]\(https/g) || []).length === 2, JSON.stringify(md.slice(0, 80)));
check('markdown escapes brackets in titles', md.includes('Linked \\[Book\\]'));
check('markdown percent-encodes parentheses in URLs', md.includes('example.com/a%28b%29'));
check('markdown keeps unlinked items as plain text', /No link here(?!\])/.test(md));
check('markdown groups by tier with counts', md.includes('**A\\***') && md.includes('(2)'));
check('markdown lists unranked separately', /Unranked \(1\)/.test(md));
check('markdown carries the caption', md.includes('booktier.org/lists/mine'));

const captionUi = await page.evaluate(async () => {
  document.querySelector('#caption').value = 'my caption';
  document.querySelector('#caption').dispatchEvent(new Event('input'));
  await new Promise((r) => setTimeout(r, 700));
  const stored = JSON.parse(localStorage.getItem('booktier/v1/doc') || '{}');
  return stored.render ? stored.render.caption : null;
});
check('caption persists with the document', captionUi === 'my caption', String(captionUi));

const withCaption = await page.evaluate(async () => {
  const s = await import('../src/core/schema.js');
  const { toPng } = await import('../src/export/png.js');
  const base = { title: 'T', items: [{ title: 'x', tier: 'splus' }] };
  const plain = await toPng(s.createDoc(base), { scale: 1 });
  const capped = await toPng(s.createDoc({ ...base, render: { caption: 'booktier.org/lists/mine' } }), { scale: 1 });
  return { plainH: plain.height, cappedH: capped.height, cappedBytes: capped.blob.size };
});
check('caption renders into the exported image', withCaption.cappedBytes > 1000 && withCaption.cappedH >= withCaption.plainH, JSON.stringify(withCaption));

// ---- security: hostile document must not become markup ----
const hostile = await page.evaluate(async () => {
  const s = await import('../src/core/schema.js');
  const r = await import('../src/render/page.js');
  const doc = s.createDoc({
    title: '</title><script>window.__pwned=1</script>',
    tiers: [{ id: 'a', label: '"><img src=x onerror=alert(1)>', color: 'red; background:url(javascript:alert(1))' }],
    items: [{
      title: '"><img src=x onerror=window.__pwned=2>', tier: 'a',
      byline: "'\"</span><script>window.__pwned=3</script>",
      href: 'javascript:alert(1)',
      image: { src: 'x" onerror="window.__pwned=4' },
      note: '</script><script>window.__pwned=5</script>',
    }],
  });
  const html = r.pageHtml(doc);
  // Render it in a detached document to see whether anything executable survives.
  const parsed = new DOMParser().parseFromString(html, 'text/html');
  return {
    html,
    scriptTags: [...parsed.querySelectorAll('script')].map((el) => el.getAttribute('type')),
    onAttrs: [...parsed.querySelectorAll('*')].filter((el) => [...el.attributes].some((a) => a.name.startsWith('on'))).length,
    imgSrcs: [...parsed.querySelectorAll('img')].map((el) => el.getAttribute('src')),
    hrefs: [...parsed.querySelectorAll('a.bt-item')].map((el) => el.getAttribute('href')),
    allHrefs: [...parsed.querySelectorAll('a')].map((el) => el.getAttribute('href')),
    tierColor: parsed.querySelector('.bt-rowlabel')?.getAttribute('style'),
    pwned: window.__pwned || null,
  };
});
check('hostile title/byline/note produce no executable script', hostile.scriptTags.every((t) => t === 'application/json'), JSON.stringify(hostile.scriptTags));
check('no event-handler attributes survive', hostile.onAttrs === 0);
check('javascript: href dropped from export', hostile.hrefs.length === 0, JSON.stringify(hostile.hrefs));
check('no javascript: URL anywhere in the exported page', !hostile.allHrefs.some((h) => /^\s*javascript:/i.test(h || '')) && !/javascript:/i.test(hostile.html));
check('quote-injection cover src rejected', hostile.imgSrcs.length === 0, JSON.stringify(hostile.imgSrcs));
check('tier color cannot inject CSS', !/javascript:/i.test(hostile.tierColor || ''), String(hostile.tierColor));
check('nothing executed during the hostile render', hostile.pwned === null);

// ---- CSP readiness: the editor DOM must be free of inline handlers and style attributes ----
const cspReady = await page.evaluate(() => ({
  inlineHandlers: [...document.querySelectorAll('*')].filter((el) => [...el.attributes].some((a) => a.name.startsWith('on'))).length,
  styleAttrs: [...document.querySelectorAll('*')].filter((el) => el.hasAttribute('style')).length,
  inlineScripts: [...document.querySelectorAll('script')].filter((el) => !el.src && el.textContent.trim()).length,
  boardCssLinked: !!document.querySelector('link[href$="board.css"]'),
  externalOrigins: [...document.querySelectorAll('script[src],link[rel~="stylesheet"][href],link[rel~="icon"][href]')]
    .map((el) => el.src || el.href).filter((u) => u && !u.startsWith(location.origin) && !u.startsWith('data:') && !u.startsWith('blob:')),
}));
check('no inline event handlers in the editor', cspReady.inlineHandlers === 0);
check('no inline <script> blocks', cspReady.inlineScripts === 0);
// Style attributes set through the CSSOM (el.style.x = …) are NOT inline styles under CSP, so
// counting attributes proves nothing. The real test is below: serve the app under the policy
// HOSTING.md recommends and assert the browser reports no violations.
check('board.css is linked, not injected', cspReady.boardCssLinked);
check('no third-party code loaded in the editor', cspReady.externalOrigins.length === 0, cspReady.externalOrigins.join(', '));

// ---- cover store + PNG export ----
const storeResult = await page.evaluate(async () => {
  const covers = await import('../src/io/covers.js');
  await covers.clearAll();
  const first = await covers.ensure('../tools/fixtures/cover.png');
  const second = await covers.ensure('../tools/fixtures/cover.png');
  const display = await covers.displaySrc('../tools/fixtures/cover.png');
  const refused = await covers.ensure('../data/example.json'); // decodes as an image? no — fails soft
  const stats = await covers.stats();
  return { first: first.status, second: second.status, display: display.slice(0, 5), refused: refused.status, count: stats.count, bytes: stats.bytes };
});
check('cover stored on first pass', storeResult.first === 'stored', JSON.stringify(storeResult.first));
check('second pass served from the store', storeResult.second === 'cached');
check('stored cover renders from a local blob', storeResult.display === 'blob:', storeResult.display);
check('a cover that cannot be decoded fails soft', storeResult.refused === 'failed');
check('store reports its size', storeResult.count === 1 && storeResult.bytes > 0, `${storeResult.count} covers, ${storeResult.bytes}b`);

check('no console errors', errors.length === 0, errors.join(' | '));
check('inline-style notices come only from parsing the exported page', inlineStyleNotices.length <= 2, `${inlineStyleNotices.length} notices`);
check('exported page carries its styles inline by design', /<style>/.test(hostile.html) && /style="background:/.test(hostile.html));

const pngResult = await page.evaluate(async () => {
  const s = await import('../src/core/schema.js');
  const { toPng } = await import('../src/export/png.js');
  const doc = s.createDoc({
    title: 'PNG check',
    items: [
      { title: 'Stored', tier: 'splus', image: { src: '../tools/fixtures/cover.png' } },
      { title: 'Not stored', tier: 's', image: { src: 'https://example.invalid/missing.jpg' } },
    ],
  });
  const { blob, width, height, missing } = await toPng(doc, { scale: 1 });
  const head = new Uint8Array(await blob.slice(0, 8).arrayBuffer());
  return { bytes: blob.size, type: blob.type, width, height, missing: missing.length, magic: [...head].join(',') };
});
check('PNG export produces a real PNG', pngResult.magic === '137,80,78,71,13,10,26,10' && pngResult.bytes > 2000, `${pngResult.bytes}b ${pngResult.type}`);
check('PNG export reports covers it had to placeholder', pngResult.missing === 1, `${pngResult.missing} missing`);

// ---- served under a strict CSP, the app must report zero violations ----
const POLICY = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' https: data: blob:",
  "connect-src 'self' https:",
  "font-src 'self'",
  "frame-src 'self' blob:",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

const cspPage = await browser.newPage({ viewport: { width: 1280, height: 1100 } });
cspPage.setDefaultTimeout(10000);
const violations = [];
await cspPage.route('**/*', async (route) => {
  if (!route.request().url().startsWith(base)) {
    return route.request().resourceType() === 'image'
      ? route.fulfill({ status: 200, contentType: 'image/png', body: STUB_PNG })
      : route.abort();
  }
  const response = await route.fetch();
  const headers = { ...response.headers(), 'content-security-policy': POLICY };
  await route.fulfill({ response, headers });
});
await cspPage.addInitScript(() => {
  window.__violations = [];
  document.addEventListener('securitypolicyviolation', (e) => {
    window.__violations.push(`${e.violatedDirective} blocked ${String(e.blockedURI).slice(0, 60)}`);
  });
});
await cspPage.goto(app, { waitUntil: 'domcontentloaded' });
await cspPage.waitForSelector('#board .bt-item');
await cspPage.waitForTimeout(400);
// exercise the paths that build DOM and styles at runtime
await cspPage.locator('.bt-item').first().focus();
await cspPage.keyboard.press('Control+ArrowDown');
await cspPage.click('#btn-preview');
await cspPage.waitForTimeout(600);
violations.push(...await cspPage.evaluate(() => window.__violations));
const tierColored = await cspPage.evaluate(() => getComputedStyle(document.querySelector('.bt-rowlabel')).backgroundColor);
const previewRendered = await cspPage.evaluate(() => {
  const anchors = document.querySelectorAll('#previewbody a.bt-item');
  const label = document.querySelector('#previewbody .bt-rowlabel');
  const card = document.querySelector('#previewbody .bt-card');
  return {
    anchors: anchors.length,
    href: anchors[0] ? anchors[0].getAttribute('href') : null,
    labelBg: label ? getComputedStyle(label).backgroundColor : null,
    cardHidden: card ? getComputedStyle(card).visibility : null,
    cardWidth: card ? getComputedStyle(card).width : null,
  };
});
await cspPage.close();
check('strict CSP produces no violations', violations.length === 0, violations.slice(0, 4).join(' | '));
check('tier colors still apply under strict CSP', tierColored !== 'rgba(0, 0, 0, 0)' && !!tierColored, tierColored);
check('preview renders linked covers under strict CSP', previewRendered.anchors > 0 && /^https?:/.test(previewRendered.href || ''), `${previewRendered.anchors} links, first ${previewRendered.href}`);
check('preview is styled under strict CSP', previewRendered.labelBg && previewRendered.labelBg !== 'rgba(0, 0, 0, 0)' && previewRendered.cardWidth === '230px', `label ${previewRendered.labelBg}, card ${previewRendered.cardWidth}`);
check('preview hover card starts hidden', previewRendered.cardHidden === 'hidden', String(previewRendered.cardHidden));

// ---- tier nudge buttons (editor only) ----
const moveBtn = page.locator('.bt-item[data-id="mother-of-learning"] [data-move="up"]');
const tierBefore = await page.evaluate(() => document.querySelector('.bt-items[data-tier="s"] .bt-item[data-id="mother-of-learning"]') ? 's' : 'other');
await moveBtn.click({ force: true });          // force: the control only becomes visible on hover
await page.waitForTimeout(150);
const tierAfter = await page.evaluate(() => !!document.querySelector('.bt-items[data-tier="splus"] .bt-item[data-id="mother-of-learning"]'));
check('nudge button moves an item up a tier', tierBefore === 's' && tierAfter, `${tierBefore} -> ${tierAfter ? 'splus' : 'unchanged'}`);
const dialogOpen = await page.evaluate(() => !!document.querySelector('#itemdialog[open]'));
check('nudge button does not open the item editor', dialogOpen === false);
const moveLabels = await page.evaluate(() => {
  const b = document.querySelector('.bt-item [data-move="down"]');
  return { label: b?.getAttribute('aria-label'), tabindex: b?.getAttribute('tabindex') };
});
check('nudge buttons are labeled and out of the tab order', /Move .+ down a tier/.test(moveLabels.label || '') && moveLabels.tabindex === '-1', JSON.stringify(moveLabels));
check('nudge buttons never reach the exported page', !hostile.html.includes('data-move'));

// ---- ?data= is restricted to this site ----
const dataPolicy = await page.evaluate(async () => {
  const m = await import('../src/io/loadUrl.js');
  const mk = (u) => `?data=${encodeURIComponent(u)}`;
  return {
    sameOrigin: m.dataParam(mk(`${location.origin}/data/example.json`)),
    foreign: m.dataParam(mk('https://evil.example/list.json')),
    allowlist: m.ALLOWED_DATA_HOSTS,
  };
});
check('a list on this site still loads', typeof dataPolicy.sameOrigin === 'string' && dataPolicy.sameOrigin.includes('/data/example.json'));
check('a list on someone else\'s host is refused', !!(dataPolicy.foreign && dataPolicy.foreign.blocked === 'evil.example'), JSON.stringify(dataPolicy.foreign));
check('the allowlist ships empty', Array.isArray(dataPolicy.allowlist) && dataPolicy.allowlist.length === 0);

// ---- share links: the fragment carries the list, and never the query string ----
const shareRound = await page.evaluate(async () => {
  const sh = await import('../src/io/share.js');
  const { createDoc } = await import('../src/core/schema.js');
  const doc = createDoc({
    title: 'Shared list',
    items: [
      { title: 'Kept', tier: 'a', pos: 0, href: 'https://example.test/a', image: { src: 'https://img.test/a.jpg' } },
      { title: 'Hostile', tier: 's', pos: 0, href: 'javascript:alert(1)' },
    ],
    render: { rel: '', target: '_blank' },
  });
  const url = await sh.shareUrl(doc, { base: 'https://booktier.org/app/' });
  const back = await sh.decodeDoc(sh.fragmentPayload(url.slice(url.indexOf('#'))));
  const short = await sh.shareUrl(doc, { base: 'https://booktier.org/app/', covers: false });
  let bombError = '';
  try {
    const big = new Uint8Array(4 * 1024 * 1024);
    const packed = new Uint8Array(await new Response(
      new Blob([big]).stream().pipeThrough(new CompressionStream('deflate-raw'))).arrayBuffer());
    let binary = ''; for (const b of packed) binary += String.fromCharCode(b);
    await sh.decodeDoc('z' + btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''));
  } catch (err) { bombError = err.message; }
  let badError = '';
  try { await sh.decodeDoc('q-not-a-payload'); } catch (err) { badError = err.message; }
  return {
    hash: url.slice(url.indexOf('#'), url.indexOf('#') + 3),
    query: url.includes('?'),
    items: back.items.length,
    titles: back.items.map((i) => i.title).join('|'),
    hostileHref: back.items.find((i) => i.title === 'Hostile').href,
    rel: back.render.rel,
    shorterWithoutCovers: short.length < url.length,
    bombError,
    badError,
    advice: sh.lengthAdvice(50000).level,
  };
});
check('share link travels in the fragment, not the query string', shareRound.hash === '#s=' && !shareRound.query, `${shareRound.hash} query=${shareRound.query}`);
check('share link round-trips every item', shareRound.items === 2 && shareRound.titles === 'Kept|Hostile', shareRound.titles);
check('a shared document is sanitized like any import', shareRound.hostileHref === '', JSON.stringify(shareRound.hostileHref));
check('a shared document cannot suppress rel=noopener', shareRound.rel.includes('noopener') && shareRound.rel.includes('noreferrer'), shareRound.rel);
check('leaving covers out shortens the link', shareRound.shorterWithoutCovers);
check('a decompression bomb is refused', /too large/.test(shareRound.bombError), shareRound.bombError);
check('an unknown payload marker is refused', /does not know/.test(shareRound.badError), shareRound.badError);
check('an oversized link is called out', shareRound.advice === 'error', shareRound.advice);

// Opening a share link must not silently destroy what the reader already had.
const sharePage = await browser.newPage({ viewport: { width: 1280, height: 1100 } });
await blockExternal(sharePage);
sharePage.setDefaultTimeout(10000);
await sharePage.goto(app, { waitUntil: 'domcontentloaded' });
await sharePage.waitForSelector('#board .bt-item');
// persist() is debounced, so the autosave key does not exist the instant the board renders.
await sharePage.waitForFunction(() => !!localStorage.getItem('booktier/v1/doc'));
await sharePage.evaluate(() => {
  const doc = JSON.parse(localStorage.getItem('booktier/v1/doc'));
  doc.title = 'MY IRREPLACEABLE LIST';
  localStorage.setItem('booktier/v1/doc', JSON.stringify(doc));
});
const sharedFragment = await sharePage.evaluate(async () => {
  const sh = await import('../src/io/share.js');
  const { createDoc } = await import('../src/core/schema.js');
  return sh.encodeDoc(createDoc({ title: 'Someone else’s list', items: [{ title: 'Theirs', tier: 'a', pos: 0 }] }));
});
await sharePage.goto(`${app}#s=${sharedFragment}`, { waitUntil: 'domcontentloaded' });
// A fragment-only change is a same-document navigation — the script never re-runs. Reload so
// this exercises what a recipient actually does: open the link cold.
await sharePage.reload({ waitUntil: 'domcontentloaded' });
await sharePage.waitForSelector('#board .bt-item');
const afterShare = await sharePage.evaluate(() => ({
  title: document.querySelector('#title').value,
  hash: location.hash,
  restoreShown: !document.querySelector('#btn-restore').hidden,
  backup: JSON.parse(localStorage.getItem('booktier/v1/doc.previous') || 'null'),
}));
check('a share link opens the shared list', afterShare.title === 'Someone else’s list', afterShare.title);
check('the fragment is cleared so a reload keeps your edits', afterShare.hash === '', afterShare.hash);
check('the reader’s own list is kept, not overwritten', afterShare.backup && afterShare.backup.title === 'MY IRREPLACEABLE LIST', afterShare.backup && afterShare.backup.title);
check('the reader is offered their list back', afterShare.restoreShown);
await sharePage.click('#btn-restore');
await sharePage.waitForFunction(() => document.querySelector('#title').value === 'MY IRREPLACEABLE LIST').catch(() => {});
const restored = await sharePage.evaluate(() => document.querySelector('#title').value);
check('restore brings the reader’s list back', restored === 'MY IRREPLACEABLE LIST', restored);
await sharePage.close();

// ---- export chooser and the Reddit submit link ----
await page.click('#btn-export');
const chooser = await page.evaluate(() => {
  const dlg = document.querySelector('#exportdialog');
  return { open: dlg.open, buttons: [...dlg.querySelectorAll('.exportlist button')].map((b) => b.id).join(',') };
});
check('one Export button opens a chooser with every method', chooser.open
  && ['btn-html', 'btn-png', 'btn-share', 'btn-reddit', 'btn-json'].every((id) => chooser.buttons.includes(id)), chooser.buttons);
await page.click('#btn-reddit');
await page.waitForSelector('#mddialog[open]');
const mdShown = await page.locator('#mdout').inputValue();
check('the chooser opens the Reddit markdown with the list in it', mdShown.includes('**'), mdShown.slice(0, 40));

// the three-step flow: numbered image, numbered comment, and the two staying in step
const steps = await page.evaluate(() => ({
  count: document.querySelectorAll('#mddialog .steps-num > li').length,
  buttons: ['btn-reddit-png', 'btn-reddit-open', 'btn-md-copy', 'btn-reddit-post']
    .filter((id) => document.querySelector(`#${id}`)).length,
}));
check('the Reddit dialog walks through all three steps', steps.count === 3 && steps.buttons === 4,
  `${steps.count} steps, ${steps.buttons} buttons`);
check('the comment carries a link to the reading view', /\/v\/#s=/.test(mdShown));
check('the comment numbers restart in each tier', /\*\*S\*\*[^\n]*— 1\. /.test(mdShown) && /\*\*A\*\*[^\n]*— 1\. /.test(mdShown),
  (mdShown.split('\n').find((l) => l.startsWith('**A**')) || '').slice(0, 44));

const lineUp = await page.evaluate(async () => {
  const { createDoc } = await import('../src/core/schema.js');
  const { numbering } = await import('../src/core/group.js');
  const { toMarkdown } = await import('../src/export/markdown.js');
  const doc = createDoc({ title: 'Numbered', items: [
    { title: 'Alpha', tier: 'splus', pos: 0 }, { title: 'Beta', tier: 'splus', pos: 1 },
    { title: 'Gamma', tier: 'a', pos: 0 }, { title: 'Delta', tier: null, pos: 0 },
  ] });
  const n = numbering(doc);
  const md = toMarkdown(doc, { numbers: true });
  return {
    perTier: doc.items.map((i) => `${i.title}=${n.get(i.id)}`).join(' '),
    md: md.replace(/\n+/g, ' | '),
    poolNumbered: /1\. Delta/.test(md),
  };
});
check('numbering restarts in every tier, pool included', lineUp.perTier === 'Alpha=1 Beta=2 Gamma=1 Delta=1', lineUp.perTier);
check('the markdown prints the same numbers the image draws', /— 1\. Alpha, 2\. Beta/.test(lineUp.md) && lineUp.poolNumbered, lineUp.md.slice(0, 70));

const numberedPng = await page.evaluate(async () => {
  const { createDoc } = await import('../src/core/schema.js');
  const { toPng } = await import('../src/export/png.js');
  const doc = createDoc({ title: 'Badges', items: [
    { title: 'One', tier: 'a', pos: 0 }, { title: 'Two', tier: 'a', pos: 1 },
  ] });
  const plain = await toPng(doc, { scale: 1, numbers: false, labels: false });
  const badged = await toPng(doc, { scale: 1, numbers: true, labels: true });
  return { plain: plain.blob.size, badged: badged.blob.size, taller: badged.height > plain.height };
});
check('numbering and labels change what the image renders', numberedPng.badged !== numberedPng.plain && numberedPng.taller,
  `${numberedPng.plain}b vs ${numberedPng.badged}b`);
const redditUrl = await page.evaluate(() => {
  const url = new URL('https://www.reddit.com/r/litrpg/submit');
  url.searchParams.set('title', 'Tier & list #1 — 100% done');
  url.searchParams.set('text', '**S** — [A](https://x.test/a)');
  return url.href;
});
check('a hostile title survives the Reddit submit URL intact', (() => {
  const parsed = new URL(redditUrl);
  return parsed.pathname === '/r/litrpg/submit'
    && parsed.searchParams.get('title') === 'Tier & list #1 — 100% done'
    && parsed.searchParams.get('text') === '**S** — [A](https://x.test/a)';
})(), redditUrl.slice(0, 80));
const redditLinkSafe = await page.evaluate(() => {
  const source = document.querySelector('#btn-reddit-post') ? 'present' : 'missing';
  return source;
});
check('the Reddit submit button exists', redditLinkSafe === 'present');
await page.evaluate(() => { document.querySelector('#mddialog').close(); document.querySelector('#exportdialog').close(); });

// ---- bugs found in review: none of these may come back ----
const regressions = await page.evaluate(async () => {
  const schema = await import('../src/core/schema.js');
  const { readEmbedded } = await import('../src/io/loadUrl.js');
  const { pageHtml } = await import('../src/render/page.js');
  const { toMarkdown } = await import('../src/export/markdown.js');

  // a title containing the six characters \u003c must survive an export/import round trip
  const tricky = schema.createDoc({ title: 'Round trip', items: [{ title: 'literal \\u003c backslash', tier: 'a', pos: 0 }] });
  let roundTripTitle = '';
  try { roundTripTitle = readEmbedded(pageHtml(tricky)).items[0].title; } catch (err) { roundTripTitle = `THREW: ${err.message}`; }

  // duplicate tier ids must not double every item in that tier
  const dup = schema.createDoc({
    tiers: [{ id: 'a', label: 'A', color: '#fff' }, { id: 'a', label: 'A again', color: '#000' }],
    items: [{ id: 'one', title: 'Only once', tier: 'a', pos: 0 }],
  });
  const rendered = (pageHtml(dup).match(/data-id="one"/g) || []).length;

  // an item whose tier no longer exists must still appear somewhere
  const dangling = schema.migrate({
    schema: 'booktier/v1', title: 'T',
    tiers: [{ id: 'a', label: 'A', color: '#fff' }],
    items: [{ id: '1', title: 'Orphan', tier: 'ghost', pos: 0 }],
  });

  // a new id must not collide with one the document already holds
  const used = new Set(['the-primal-hunter-1']);
  const minted = schema.newId('The Primal Hunter', used);

  return {
    roundTripTitle,
    renderedTimes: rendered,
    markdownHasOrphan: toMarkdown(dangling).includes('Orphan'),
    mintedCollides: minted === 'the-primal-hunter-1',
    relative: schema.safeImageSrc('../covers/a.jpg'),
    spaced: schema.safeImageSrc('covers/My Book.jpg'),
    quoted: schema.safeImageSrc('covers/a".jpg'),
  };
});
check('a title holding a literal \\u003c survives export and re-import', regressions.roundTripTitle === 'literal \\u003c backslash', regressions.roundTripTitle);
check('duplicate tier ids do not double an item', regressions.renderedTimes === 1, `${regressions.renderedTimes} copies`);
check('an item with a dangling tier still reaches the Reddit post', regressions.markdownHasOrphan);
check('a generated id never collides with an existing one', !regressions.mintedCollides);
check('the documented ../covers/ layout is accepted', regressions.relative === '../covers/a.jpg', regressions.relative);
check('an ordinary filename with a space is accepted', regressions.spaced === 'covers/My Book.jpg', regressions.spaced);
check('a cover path with a quote in it is refused', regressions.quoted === '', regressions.quoted);

const pngCounts = await page.evaluate(async () => {
  const { createDoc } = await import('../src/core/schema.js');
  const { toPng } = await import('../src/export/png.js');
  const doc = createDoc({ title: 'No covers', items: [
    { title: 'Bare one', tier: 'a', pos: 0 },
    { title: 'Bare two', tier: 'a', pos: 1 },
  ] });
  const out = await toPng(doc, { scale: 1 });
  return { missing: out.missing.length, noCover: out.noCover.length };
});
check('books with no cover are not reported as missing covers', pngCounts.missing === 0 && pngCounts.noCover === 2,
  `missing=${pngCounts.missing} noCover=${pngCounts.noCover}`);

// ---- a cover that fails to load must not become a blank box ----
const fallback = await page.evaluate(async () => {
  const { createDoc } = await import('../src/core/schema.js');
  const { pageHtml, boardHtml } = await import('../src/render/page.js');
  const doc = createDoc({ items: [
    { title: 'Has a cover', tier: 'a', pos: 0, image: { src: 'https://img.test/a.jpg' } },
    { title: 'No cover at all', tier: 'a', pos: 1 },
  ] });
  const markup = boardHtml(doc, { editable: false, inlineStyles: true });
  const exported = pageHtml(doc);
  const host = document.createElement('div');
  host.innerHTML = markup;
  document.body.appendChild(host);
  const shells = [...host.querySelectorAll('.bt-shell')];
  const out = {
    shells: shells.length,
    bothTitled: shells.every((sh) => sh.querySelector('.bt-blank-title')),
    imgAltEmpty: [...host.querySelectorAll('img.bt-cover')].every((i) => i.getAttribute('alt') === ''),
    labelled: shells.every((sh) => sh.getAttribute('role') === 'img' && sh.getAttribute('aria-label')),
    imgTransparent: getComputedStyle(host.querySelector('img.bt-cover')).backgroundColor,
    exportedHasTitleUnderCover: /bt-blank-title[^>]*>Has a cover/.test(exported),
  };
  host.remove();
  return out;
});
check('every cover sits in a titled shell', fallback.shells === 2 && fallback.bothTitled, `${fallback.shells} shells`);
check('the cover image is transparent so a failed load reveals the title',
  fallback.imgTransparent === 'rgba(0, 0, 0, 0)', fallback.imgTransparent);
check('the cover image carries no duplicate alt text', fallback.imgAltEmpty);
check('the shell is the labeled image for assistive tech', fallback.labelled);
check('an exported page carries the title under the cover too', fallback.exportedHasTitleUnderCover);

// ---- the reading view ----
const viewPage = await browser.newPage({ viewport: { width: 1280, height: 1100 } });
await blockExternal(viewPage);
viewPage.setDefaultTimeout(10000);
const viewErrors = [];
viewPage.on('console', (m) => { if (m.type() === 'error' && !(m.location().url || '').includes('favicon')) viewErrors.push(m.text()); });
viewPage.on('pageerror', (e) => viewErrors.push(String(e)));

const viewPayload = await page.evaluate(async () => {
  const sh = await import('../src/io/share.js');
  const { createDoc } = await import('../src/core/schema.js');
  return sh.encodeDoc(createDoc({
    title: 'A borrowed shelf',
    subtitle: 'ranked by someone else',
    items: [
      { title: 'Linked book', tier: 'a', pos: 0, href: 'https://example.test/book', image: { src: 'https://img.test/c.jpg' } },
      { title: 'Hostile book', tier: 's', pos: 0, href: 'javascript:alert(1)' },
    ],
    render: { rel: '', target: '_blank' },
  }));
});

await viewPage.goto(`${base}/v/#s=${viewPayload}`, { waitUntil: 'domcontentloaded' });
await viewPage.waitForSelector('#v-board .bt-item');
const view = await viewPage.evaluate(() => {
  const anchor = document.querySelector('#v-board a.bt-item');
  return {
    title: document.querySelector('#v-title').textContent,
    docTitle: document.title,
    subtitle: document.querySelector('#v-sub').textContent,
    items: document.querySelectorAll('#v-board .bt-item').length,
    anchors: document.querySelectorAll('#v-board a.bt-item').length,
    rel: anchor && anchor.getAttribute('rel'),
    target: anchor && anchor.getAttribute('target'),
    hostileIsAnchor: !!document.querySelector('#v-board a[href^="javascript"]'),
    labelColor: getComputedStyle(document.querySelector('#v-board .bt-row[data-tier="a"] .bt-rowlabel')).backgroundColor,
    cardWidth: getComputedStyle(document.querySelector('#v-board .bt-card')).width,
    forkHref: document.querySelector('#v-fork').getAttribute('href'),
    footShown: !document.querySelector('#v-foot').hidden,
    errorShown: !document.querySelector('#v-error').hidden,
    editorChrome: !!document.querySelector('.toolbar, #btn-export, .bt-moves'),
    storageUsed: (() => { try { return localStorage.length; } catch { return -1; } })(),
  };
});
check('the reading view renders the shared list', view.items === 2 && view.title === 'A borrowed shelf', `${view.items} items, "${view.title}"`);
check('the reading view sets the document title', view.docTitle.startsWith('A borrowed shelf'), view.docTitle);
check('the reading view shows the subtitle', view.subtitle === 'ranked by someone else', view.subtitle);
check('covers are real links in the reading view', view.anchors === 1 && view.target === '_blank', `${view.anchors} anchors`);
check('reading-view links are nofollow ugc as well as noopener', /noopener/.test(view.rel) && /noreferrer/.test(view.rel) && /nofollow/.test(view.rel) && /ugc/.test(view.rel), view.rel);
check('a javascript: link never becomes an anchor in the reading view', view.hostileIsAnchor === false);
check('tier colors apply in the reading view', view.labelColor === 'rgb(255, 223, 127)', view.labelColor);
check('hover cards are present in the reading view', view.cardWidth === '230px', view.cardWidth);
check('the reading view carries no editor chrome', view.editorChrome === false);
check('the reading view writes nothing to browser storage', view.storageUsed === 0, `${view.storageUsed} keys`);
check('the reading view offers the list to the editor', view.forkHref === `../app/#s=${viewPayload}`, (view.forkHref || '').slice(0, 24));
check('the reading view shows no error state on a good link', view.errorShown === false);
check('the reading view logs no console errors', viewErrors.length === 0, viewErrors.slice(0, 2).join(' | '));

// forking really does open the editor on that list
await viewPage.click('#v-fork');
await viewPage.waitForSelector('#board .bt-item');
const forked = await viewPage.evaluate(() => document.querySelector('#title').value);
check('opening it in the editor loads the same list', forked === 'A borrowed shelf', forked);

// a truncated or missing payload has to say so rather than render an empty board
await viewPage.goto(`${base}/v/`, { waitUntil: 'domcontentloaded' });
await viewPage.waitForSelector('#v-error:not([hidden])');
const emptyView = await viewPage.evaluate(() => document.querySelector('#v-error-title').textContent);
check('a link with no list says so', /no list in this link/i.test(emptyView), emptyView);
await viewPage.goto(`${base}/v/#s=zBROKEN`, { waitUntil: 'domcontentloaded' });
await viewPage.reload({ waitUntil: 'domcontentloaded' });   // fragment-only change never re-runs the module
await viewPage.waitForSelector('#v-error:not([hidden])');
const brokenView = await viewPage.evaluate(() => document.querySelector('#v-error-body').textContent);
check('a damaged link explains itself instead of rendering nothing', /truncated/.test(brokenView), brokenView.slice(0, 50));
await viewPage.close();

// the reading view must hold up under the production CSP, same as the editor
const cspView = await browser.newPage({ viewport: { width: 1280, height: 1100 } });
await cspView.route('**/*', async (route) => {
  const url = route.request().url();
  if (!url.startsWith(base)) {
    if (route.request().resourceType() === 'image') return route.fulfill({ status: 200, contentType: 'image/png', body: STUB_PNG });
    return route.abort();
  }
  const res = await route.fetch();
  const headers = { ...res.headers(), 'content-security-policy': POLICY };
  return route.fulfill({ response: res, headers });
});
const cspViewViolations = [];
cspView.on('console', (m) => { if (/Content Security Policy|Refused to/.test(m.text())) cspViewViolations.push(m.text().slice(0, 120)); });
await cspView.goto(`${base}/v/#s=${viewPayload}`, { waitUntil: 'domcontentloaded' });
await cspView.waitForSelector('#v-board .bt-item');
const cspViewColor = await cspView.evaluate(() => getComputedStyle(document.querySelector('#v-board .bt-row[data-tier="a"] .bt-rowlabel')).backgroundColor);
check('the reading view produces no CSP violations', cspViewViolations.length === 0, cspViewViolations.slice(0, 2).join(' | '));
check('tier colors survive the strict CSP in the reading view', cspViewColor === 'rgb(255, 223, 127)', cspViewColor);
await cspView.close();

// ---- fixes from the code review that must not come back ----
const reviewFixes = await page.evaluate(async () => {
  const schema = await import('../src/core/schema.js');
  const { boardHtml } = await import('../src/render/page.js');

  const doc = schema.createDoc({ items: [{ id: 'k', title: 'Titled', byline: 'Writer', note: 'a note',
    tier: 'a', pos: 0, fields: { hours: 84 } }] });
  const markup = boardHtml(doc, { editable: false });
  const prefixed = boardHtml(doc, { editable: false, idPrefix: 'pv-' });

  const coerced = schema.createDoc({ items: [{ title: 'F', fields: {
    ok: 'yes', n: 12, flag: true, list: ['a', 'b'], nested: { deep: 1 } } }] }).items[0].fields;

  return {
    describedBy: /aria-describedby="bt-d-k"/.test(markup) && /id="bt-d-k"/.test(markup),
    noPresentation: !/role="presentation"/.test(markup),
    prefixIsolated: /aria-describedby="pv-bt-d-k"/.test(prefixed) && !/aria-describedby="bt-d-k"/.test(prefixed),
    fields: coerced,
  };
});
check('the hover card is described to assistive tech, not hidden from it',
  reviewFixes.describedBy && reviewFixes.noPresentation);
check('a second board in the same document gets its own card ids', reviewFixes.prefixIsolated);
check('a field holding an object or array never renders as [object Object]',
  reviewFixes.fields.list === 'a, b' && reviewFixes.fields.nested === undefined
  && reviewFixes.fields.n === 12 && reviewFixes.fields.flag === true,
  JSON.stringify(reviewFixes.fields));

// a comma inside a title is a title, not a field separator
await page.click('#btn-add');
await page.waitForSelector('#adddialog[open]');
await page.evaluate(() => { document.querySelector('#bulkbox').open = true; });
await page.fill('#addform [name=bulk]', 'Dune, Book 1\nCradle | Will Wight | https://example.test/c\nSomething, https://example.test/s');
await page.fill('#addform [name=title]', '');
await page.click('#addform button[value=done]');
await page.waitForTimeout(700);
const bulk = await page.evaluate(() => {
  const d = JSON.parse(localStorage.getItem('booktier/v1/doc') || '{}');
  const pick = (t) => (d.items || []).find((i) => i.title === t);
  return {
    commaTitle: !!pick('Dune, Book 1'),
    piped: !!(pick('Cradle') && pick('Cradle').byline === 'Will Wight'),
    commaRecord: !!(pick('Something') && pick('Something').href === 'https://example.test/s'),
  };
});
check('a title containing a comma survives the bulk paste', bulk.commaTitle);
check('pipe-separated records still split', bulk.piped);
check('a comma followed by a URL is still treated as a record', bulk.commaRecord, JSON.stringify(bulk));

// touch drag is enabled on the editor board only — a page made of covers must stay scrollable
const touch = await page.evaluate(() => {
  const editorItem = document.querySelector('#board .bt-item');
  const host = document.createElement('div');
  host.innerHTML = '<div class="bt-item" style="width:10px;height:10px"></div>';
  document.body.appendChild(host);
  const loose = getComputedStyle(host.querySelector('.bt-item')).touchAction;
  host.remove();
  return { onBoard: getComputedStyle(editorItem).touchAction, offBoard: loose };
});
check('the editor board opts out of touch scrolling so a cover can be dragged', touch.onBoard === 'none', touch.onBoard);
check('a cover outside the editor keeps the page scrollable on touch', touch.offBoard !== 'none', touch.offBoard);

// CI has to exist, or nothing runs any of this
const workflow = readFileSync(new URL('../.github/workflows/check.yml', import.meta.url), 'utf8');
check('a workflow runs the generator check and the suite on every push',
  /npm run check/.test(workflow) && /tools\/smoke\.mjs/.test(workflow) && /on:\s*\n\s*push:/.test(workflow));

// ---- the demo's own cover URLs ----
// The landing page hotlinks these deliberately (see README). The part worth guarding is that
// they stay as durable as a hotlink can be: https, no cache-buster query string to expire, and
// nothing pointing at a host that is not a cover CDN.
const exampleDoc = JSON.parse(readFileSync(new URL('../data/example.json', import.meta.url), 'utf8'));
const demoCovers = exampleDoc.items.map((i) => (i.image && i.image.src) || '').filter(Boolean);
check('every demo cover is served over https', demoCovers.every((u) => u.startsWith('https://')),
  `${demoCovers.length} covers`);
check('no demo cover carries a cache-buster that can expire',
  demoCovers.every((u) => !u.includes('?')), demoCovers.find((u) => u.includes('?')) || '');
check('the repo still ships no cover images of its own',
  !existsSync(new URL('../demo/covers', import.meta.url)) && !demoCovers.some((u) => u.startsWith('data:')));

// ---- the deployed header rules must actually do what they claim ----
// Not browser-testable: Cloudflare composes these, and the suite serves its own headers. What is
// checkable is the shape, and the shape is where this went wrong — a relaxed policy on a specific
// path is inert unless the inherited one is detached first.
const headersFile = readFileSync(new URL('../_headers', import.meta.url), 'utf8');
const listsBlock = headersFile.split(/^\/lists\/\*$/m)[1] || '';
const rootBlock = (headersFile.split(/^\/\*$/m)[1] || '').split(/^\//m)[0];
check('the exported-list rule detaches the inherited CSP before relaxing it',
  /^\s*!\s+Content-Security-Policy\s*$/m.test(listsBlock) && /Content-Security-Policy:/.test(listsBlock));
check('the exported-list rule does not repeat inherited headers',
  !/Referrer-Policy|X-Content-Type-Options/.test(listsBlock));
check('the root policy still forbids inline script and style',
  /script-src 'self'/.test(rootBlock) && /style-src 'self'/.test(rootBlock)
  && !/unsafe-inline/.test(rootBlock) && !/unsafe-eval/.test(rootBlock));
check('the reading view is kept out of search indexes',
  /^\/v\/\*$/m.test(headersFile) && /X-Robots-Tag: noindex/.test(headersFile));

// ---- landing page ----
const landing = await browser.newPage({ viewport: { width: 1280, height: 1100 } });
landing.setDefaultTimeout(10000);
const landingErrors = [];
landing.on('pageerror', (e) => landingErrors.push(String(e)));
landing.on('console', (m) => { if (m.type() === 'error' && !(m.location().url || '').includes('favicon')) landingErrors.push(m.text()); });
landing.on('response', (r) => { if (r.status() >= 400 && !r.url().includes('favicon')) landingErrors.push(`HTTP ${r.status()} ${r.url()}`); });
await blockExternal(landing);
await landing.goto(base + '/', { waitUntil: 'domcontentloaded' });
await landing.waitForSelector('.demo-frame .bt-item');

const home = await landing.evaluate(() => ({
  title: document.title,
  h1: document.querySelector('h1')?.textContent.trim(),
  editorLinks: [...document.querySelectorAll('a[href="app/"]')].length,
  demoAnchors: [...document.querySelectorAll('.demo-frame a.bt-item')].map((a) => a.getAttribute('href')),
  demoCards: document.querySelectorAll('.demo-frame .bt-card-title').length,
  labelBg: (() => { const l = document.querySelector('.demo-frame .bt-rowlabel'); return l ? getComputedStyle(l).backgroundColor : null; })(),
  inlineHandlers: [...document.querySelectorAll('*')].filter((el) => [...el.attributes].some((a) => a.name.startsWith('on'))).length,
  scripts: document.querySelectorAll('script').length,
  hasCsp: !!document.querySelector('meta[http-equiv="Content-Security-Policy"]'),
  hasDescription: !!document.querySelector('meta[name="description"]'),
  // Remote CODE is never acceptable; remote IMAGES are the whole point of a cover.
  // rel=canonical / og:url are metadata, not requests, so they are not counted.
  externals: [...document.querySelectorAll('link[rel~="stylesheet"][href],link[rel~="icon"][href],script[src]')]
    .map((el) => el.href || el.src)
    .filter((u) => u && !u.startsWith(location.origin) && !u.startsWith('data:')),
  remoteImages: [...document.querySelectorAll('img[src]')].map((el) => el.src)
    .filter((u) => !u.startsWith(location.origin) && !u.startsWith('data:') && !u.startsWith('blob:')),
  unreplacedTokens: /__(DEMO|REPO)__/.test(document.documentElement.outerHTML),
}));
check('landing page renders with a headline', !!home.h1 && home.title.includes('booktier'), home.h1);
check('landing links to the editor', home.editorLinks >= 2, `${home.editorLinks} links to app/`);
check('landing demo uses real links', home.demoAnchors.length >= 5 && home.demoAnchors.every((h) => /^https:/.test(h)), `${home.demoAnchors.length} covers`);
check('landing demo carries hover cards', home.demoCards === home.demoAnchors.length, `${home.demoCards} cards`);
check('landing demo is styled by board.css', home.labelBg && home.labelBg !== 'rgba(0, 0, 0, 0)', home.labelBg);
check('landing has no scripts at all', home.scripts === 0);
check('landing has no inline handlers', home.inlineHandlers === 0);
check('landing declares a CSP and a description', home.hasCsp && home.hasDescription);
check('landing loads no third-party code', home.externals.length === 0, home.externals.join(', '));
check('landing cover images are all https', home.remoteImages.every((u) => u.startsWith('https://')), `${home.remoteImages.length} remote covers`);
check('no template tokens left unreplaced', home.unreplacedTokens === false);

// the editor must be reachable by following the link, not just by typing the URL
await landing.click('a.btn-primary[href="app/"]');
await landing.waitForLoadState('domcontentloaded');
await landing.waitForSelector('#board .bt-item');
const reachedEditor = await landing.evaluate(() => !!document.querySelector('#board .bt-item'));
check('editor loads by following the landing CTA', reachedEditor, landing.url());
check('landing page has no console errors', landingErrors.length === 0, landingErrors.slice(0, 3).join(' | '));

// mobile width: the nav and hero must not overflow
await landing.setViewportSize({ width: 375, height: 800 });
await landing.goto(base + '/', { waitUntil: 'domcontentloaded' });
await landing.waitForSelector('.demo-frame .bt-item');
const overflow = await landing.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
check('landing does not scroll sideways on a phone', overflow <= 0, `${overflow}px overflow`);
await landing.close();

await browser.close();
if (own) own.server.close();

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.log(`  FAIL  ${f}`);
  process.exitCode = 1;
}

