// Smoke test for the editor. Requires playwright and a static server on BASE_URL.
//   python3 -m http.server 8777 & npx playwright install chromium && node tools/smoke.mjs
import { chromium } from 'playwright';

const base = (process.env.BASE_URL || 'http://127.0.0.1:8777').replace(/\/$/, '');
const app = `${base}/app/`;
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
// Cover images point at a third-party host. The tests check markup and behavior, not pixels,
// so off-origin image requests are answered with a local stub and everything else off-origin is
// refused. Aborting the images instead makes the page retry them hard enough to starve the
// input queue, which hangs page.mouse.move mid-drag — and it made the suite depend on Royal
// Road being reachable, which a test suite should never do.
import { readFileSync } from 'node:fs';
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


const check = (name, cond, extra='') => console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + extra : ''}`);

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

