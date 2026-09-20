# Linked-cover tier list — architecture synthesis

v0.2 · 2026-09-20 · based on a code review of nine open-source tier list projects.

Decisions taken: browser editor first; greenfield MIT repo porting techniques rather than a
fork; schema and UI built around books. §4 reflects the shipped layout.

## 1. What the review established

Nine repos were cloned and read. The headline finding is uniform:

**Not one of the nine has a per-item link, and not one has per-item hover metadata.**
Every item model is some variant of `{id, image, label}`. Two of the nine
(`silverweed/tiers`, `milk3e`) reference an `alt` attribute that is never actually set.
No project wraps a cover in an `<a>`. The feature has to be built regardless of base.

One closed-source site does have the feature. LitRPGTools renders each cover as an anchor to its
own `/books/<id>` page, with a `title` attribute and a hover card carrying title and author. Its
constraints are the product, not the implementation: the link target is always its own catalog,
only books in that catalog can be ranked, creating a list requires an account, and the artifact
lives on its server. Its hover card is also `hover`-only — no focus state — so keyboard users get
the native tooltip and nothing else. Verified in-browser 2026-09-20.

The deeper reason no open-source tool has it is that all nine treat **a picture of the list as
the output**. PNG export is
the terminal artifact in seven of them; the other two (`tier-list-now`, `opentierboy`) share a
compressed URL that rehydrates the app. Links and tooltips cannot survive either path. Changing
the output format — a static HTML page as the primary artifact — is the architectural decision
that makes this project different, not an item field.

### Per-repo verdicts

| Repo | License | Size | What it's worth |
|---|---|---|---|
| `silverweed/tiers` | WTFPL | 769 JS + 302 CSS, zero deps | Cleanest small codebase. Best hand-rolled DnD (computed insertion marker). Real JSON save/load. `?url=` query-param loader fetches a tier list JSON — the closest thing to a publish path in any of the nine. |
| `milk3e/Tier-List-Maker` | CC0 | 4,298-line single HTML, zero deps | Per-item side-table metadata (`descriptions`, `fileNames`, `cropData`) keyed by image hash; hover "zoom portal" overlay showing description + rank; a **dependency-free canvas PNG exporter** (no html2canvas). Most directly reusable techniques. |
| `infinia-yzl/opentierboy` | AGPL-3.0 | Next.js, 295 files | The URL-state design (`lib/TierCortex.ts`, lz-string) is elegant, and its failure modes are instructive — see §5. Template image sets shipped as npm packages is a good idea. AGPL + Vercel coupling make it a poor fork base. |
| `Elliot67/tier-list-now` | AGPL-3.0 | Vue, tested | Best-typed data model and the only repo with CI-enforced unit tests on serialization. But items are **colored squares — it has no images at all**, which is most of what a cover-based tool does. |
| `nathan71370/tierlistrr` | MIT | Next.js + SQLite + Docker | Backend-coupled. Two portable pieces: `groupByPlacement`/`toPlacements` (pure functions), and a consensus algorithm that averages each item's tier index across participants with per-tier opt-out. |
| `SuperFola/TierListMaker` | MIT | ~400 lines vanilla | Items *are* DOM nodes; no data model, no persistence. Little to take. |
| `joeseesun/hangbang` | MIT | Vite/React | Free-form absolutely-positioned canvas — tier membership is inferred from pixel overlap, not stored. Good image pipeline (downscale to 1400px, WebP q0.84), IndexedDB-with-localStorage-fallback persistence. Wrong model for us. |
| `zhangchenchen/tier_list_maker` | **Proprietary** | Next.js SaaS boilerplate | README claims MIT; the LICENSE file forbids public redistribution of source. **Unusable.** Ideas only. |
| `Bretimproper361/Tier-List-Maker` | **None** | 3 files | Unlicensed (no reuse rights). Also ships `xiphopagus/List_Tier_Maker_v3.4.zip` containing `binc.exe` / `lua51.dll` with a README urging users to run it. Not extracted, not executed. **Avoid entirely.** |

## 2. Design principles

1. **An item is a record, not a DOM node and not an id.** Four repos store items as `<img>`
   elements; `opentierboy` stores an id and resolves it from a lookup table. Both make adding a
   `href` a cross-cutting change. A plain serializable record makes it a field.
2. **The HTML page is the deliverable; the PNG is a fallback.** Inverted from every reviewed tool.
3. **The JSON file is the state of record; the URL is a convenience.** See §5 for why the reverse
   does not survive contact with per-item links.
4. **Never persist a reference that outlives its meaning.** `opentierboy` writes `blob:` object
   URLs into localStorage and shared links, so custom images silently become placeholders after a
   reload. Covers are stored as durable URLs, or as inlined data at export time — never blobs.
5. **Links are focusable; tooltips must be too.** None of the nine has keyboard-operable drag or
   keyboard-reachable hover metadata. An anchor gets focus for free; the hover card must render on
   `:focus-visible` as well as `:hover`.

## 3. Data model

```jsonc
{
  "schema": "booktier/v1",           // version gate, migrate on load
  "title": "LitRPG — 59 series, 3,044 hours",
  "tiers": [
    { "id": "splus", "label": "S+", "color": "#ff7f7f" }
  ],
  "items": [
    {
      "id": "primal-hunter",          // stable key; also used for image dedup
      "tier": "s-plus",               // null = unplaced pool
      "pos": 0,
      "title": "The Primal Hunter",   // hover card line 1 + <a> title attr + img alt
      "byline": "Zogarth",            // hover card line 2
      "href": "https://...",          // THE missing feature
      "image": { "src": "covers/primal-hunter.jpg", "w": 200, "h": 300 },
      "note": "",                     // optional free text in the hover card
      "fields": { "hours": 84, "volumes": 12 }   // arbitrary; template decides display
    }
  ],
  "render": {
    "tooltip": "card",                // "card" | "native" | "none"
    "target": "_blank",
    "rel": "noopener noreferrer",
    "showLabels": false
  }
}
```

`fields` is the escape hatch that keeps the schema from growing a column per use case — it is
what lets a books list show hours and volumes while a games list shows playtime, with no schema
change. Adapted from `milk3e`'s side-table pattern, but folded into the item record so a single
object round-trips through save, share, and export.

## 4. Module layout

```
src/core/schema.js    types, normalization, href sanitizing, validate(), migrate()
src/core/group.js     groupByTier / applyPlacement  (shape from tierlistrr, MIT)
src/io/store.js       localStorage autosave, quota-aware
src/io/covers.js      IndexedDB cover store: fetch once, downscale, dedupe by URL hash
src/export/png.js     canvas PNG renderer, zero-dep  (technique from milk3e, CC0)
src/io/loadUrl.js     ?data=<url> loader + embedded-document re-import
src/render/page.js    itemHtml / boardHtml / pageHtml + BOARD_CSS
src/editor/dnd.js     pointer DnD with insertion marker  (technique from silverweed, WTFPL)
src/editor/app.js     wiring, item form, bulk add, keyboard placement, exports
index.html            the landing page, generated by tools/build-site.mjs
app/index.html        the editor shell
```

Two structural rules hold this together:

- **`core/` and `render/` never touch the DOM or `window`.** `render/page.js` returns strings.
  That is what lets the same code run under Node for a future CLI (`booktier build list.json`)
  and lets the core be unit-tested without a browser.
- **The editor board and the exported page are produced by the same `boardHtml()`.** `BOARD_CSS`
  in `render/page.js` is the single source for board styling; `tools/build-css.mjs` writes it out
  to `src/render/board.css` so the editor can load it as a real stylesheet under a CSP with no
  `unsafe-inline`, and `--check` fails if the two drift. What you drag is what you publish.

No dependencies at runtime and nothing to build at deploy time: the editor is ES modules served
statically. Two generators (`tools/build-css.mjs`, `tools/build-site.mjs`) produce
`src/render/board.css`, `src/site/demo.css` and the landing `index.html`; their output is
committed, and `npm run check` fails when it is stale.

## 5. Why URL-state is secondary — and what it turned into

`opentierboy` compresses `{i: id, c?: label}` per item with lz-string and still warns the user at
2,000 characters (`components/TierListManager.tsx:203-259`). Our item carries a title, a byline,
an href, and a cover reference — roughly 80–150 bytes before compression against their ~10.
A 59-item list is 5–9 KB raw. Compressed it may fit a URL; it may not, and it degrades silently
in exactly the links people paste into Reddit.

So: the shareable artifact is **a JSON file plus a page that loads it** (`?data=<url>`,
silverweed's pattern), or a single self-contained HTML file. URL state is a convenience beside
those, never the state of record.

It ships as `src/io/share.js`: the document is deflated and base64url-encoded into the **fragment**
(`#s=…`), never the query string, because a fragment is not sent to any server — a tool that says
nothing leaves the browser cannot make the share button the exception that puts every visitor's
reading list in someone's access log. Measured on a real 59-item list: 3.1 KB with covers, 2.3 KB
without, 0.9 KB for the ranking alone. The share dialog shows the length and says plainly where a
link of that size stops being reliable, rather than truncating silently.

Two rules the loader keeps: the decompressed side is capped as it streams (a small fragment can
otherwise inflate into an arbitrarily large document), and the result goes through the same
`migrate` + `validate` gate as any other import. The fragment is cleared from the address bar once
read, so reloading does not re-apply the sender's version over the reader's edits.

## 5a. The cover store

Covers are fetched once, downscaled to a 320px edge (~20 KB webp), and stored in IndexedDB under
a SHA-256 prefix of their source URL. Items keep the original URL as their reference; the store
is a parallel map from that URL to bytes.

Three things follow from storing bytes rather than caching requests:

- **PNG export becomes possible at all.** See §6 — this is the load-bearing reason.
- **Lists become durable.** A stored cover survives the source URL rotating, the host changing
  its CORS policy, and being offline.
- **Storage is shared across lists.** The same cover in five lists costs one copy.

Failure is soft by design: `ensure()` returns a status rather than throwing, an unstorable cover
still displays from its original URL (plain display never requires permission), and only the PNG
degrades, to a labeled placeholder.

## 6. Two traps worth naming before any code

**Canvas tainting — measured, not assumed.** PNG export draws covers onto a canvas, and a cover
from a host that does not send permissive CORS headers taints it, making the export throw. Tested
in a real browser on 2026-09-20 from a neutral origin: **m.media-amazon.com and
www.royalroadcdn.com both send the headers**, so their covers can be read back cleanly.
royalroad.com's own site assets do not, and Goodreads was untested (dead URL). The store in §5a
settles it either way — export draws only from stored bytes, so it never touches a remote origin
and cannot taint. Method note: the first run of this test was executed from another site's page
and reported everything blocked, which was that page's own `connect-src` policy, not the image
hosts. Test CORS from a neutral origin.

**Cover art.** Hotlinking retailer cover images is fragile and of uncertain standing; storing them
is a separate question. The repo should ship a documented position and a `covers/` convention
rather than leave users to guess.

## 6a. Security posture

The app renders documents it did not write (imported files, `?data=` links), so untrusted input
is the whole threat model. Escaping at render, scheme allowlists for links and cover sources,
size and content-type caps on remote documents, a preview that renders through the app's own
renderer rather than an iframe, no inline scripts or styles in the app itself, and zero runtime
dependencies. `SECURITY.md` has the trust boundaries and the residual risks; `HOSTING.md` has the
Content-Security-Policy, which `tools/smoke.mjs` applies to a live browser session and fails on
any violation.

## 7. Licensing

- Reuse from `milk3e` (CC0) and `silverweed` (WTFPL) carries no obligations — techniques or code,
  either way, and neither forces a license on us.
- `tierlistrr` (MIT) needs attribution only.
- `opentierboy` and `tier-list-now` are **AGPL-3.0** — copying code from either forces AGPL on the
  whole project *including hosted deployments*. Ideas and public interfaces are fine; code is not.
  Nothing from them is proposed for copying.
- Therefore the project can be MIT, with a CREDITS.md naming each source and what was taken.
