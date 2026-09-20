# booktier

Tier lists for books, where every cover is a link.

**[booktier.org](https://booktier.org)** — hosted, free, no account.

Open-source tier list makers treat a PNG as the finished product. That works until someone asks
"what's that one in S tier?" — a picture can't answer, and it can't be clicked. booktier's
output is a web page: each cover is an anchor to wherever the book lives (Amazon, Royal Road,
Goodreads, your own review), and hovering or tab-focusing it shows the title, the author, and
whatever else you put on the record.

## Prior art

[LitRPGTools](https://www.litrpgtools.com/tier-lists) already does linked covers with hover
cards, and does it well — but only inside its own walls: covers link to its catalog pages, the
books you can rank are the books it has, creating a list requires an account, and the list lives
on their server. booktier is for the other case: your data, your links, your file, any subject,
no account. If you want a LitRPG list inside a LitRPG community, use theirs.

Among the nine **open-source** tier list projects surveyed (see `CREDITS.md`), none supports a
per-item link or hover metadata at all.

**Status: early.** The editor works. The roadmap below is honest about what is missing.

## What it does

- Drag covers between tiers, tap the ▲▼ buttons on a cover, or move them from the keyboard —
  focus a cover, then `Ctrl`+`↑`/`↓` to change tier and `Ctrl`+`←`/`→` to reorder. The buttons
  are always visible on touch devices, where dragging is fiddly and shortcuts don't exist.
- Give each book a title, author, link, cover image, a note, and arbitrary extra fields
  (`hours: 84`, `volumes: 12`) that show in the hover card.
- Save covers once into a local store, then render from the saved copies. Fetch a cover a second
  time and it comes from disk. Amazon's and Royal Road's cover hosts both allow this; hosts that
  don't are handled without breaking the list.
- Export a standalone HTML page. No JavaScript, no build step, no external requests except the
  cover images themselves — or bake the saved covers into the file and it needs no network at all.
  The hover card is pure CSS and works on focus as well as hover.
- Export a PNG for pasting into Reddit or Discord, drawn directly on a canvas with no
  third-party library. Covers missing from the store become labeled placeholders rather than
  failing the export.
- Export JSON, and import it again. An exported page can also be re-imported — the source
  document is embedded in it.
- Autosaves to your browser. Nothing is uploaded anywhere; there is no server.

## Using it

Open `index.html` through any static web server (ES modules will not load from `file://`):

```
npm run serve       # node tools/serve.mjs, http://localhost:8777
```

Every push and pull request runs `npm run check` and the full suite through GitHub Actions
(`.github/workflows/check.yml`), so a stale generated file or a regression fails before it can be
deployed.

Run the checks yourself with `npm run smoke` (needs `npx playwright install chromium` once; set
`CHROMIUM_PATH` if you have a browser it should use instead). It starts its own server, drives a
real browser — drag and drop, keyboard placement, the cover store, PNG output, share links,
escaping of hostile documents, a pass with the production Content-Security-Policy applied — and
**exits non-zero if any check fails**.

Add books one at a time, or paste a batch as `Title | Author | link | cover image URL` per line
(tabs work too; a comma splits a line only when one is followed by a link, so a title containing a
comma stays intact).
Drag them into tiers, then open **Export or share…**:

| | |
| --- | --- |
| **Web page** | a standalone `.html` file to host anywhere |
| **Image** | a `.png` for Reddit or Discord — press **Save covers** first |
| **Share link** | a URL that opens the list as a finished reading page in someone else's browser |
| **Post to Reddit** | a three-step flow: a numbered, titled image, then the matching link list as the first comment |
| **JSON** | the document itself, the copy you own |

A Reddit post can carry an image **or** clickable links, never both — that is Reddit's limit, not
booktier's. So the Reddit flow splits them: an image with the title under each cover and a number
on it, and a first comment carrying the same numbers beside real links. A reader sees a cover they
like, reads its number, and finds the link. The comment also links to the reading view, which is
the only place the two come back together.

A share link carries the whole list in the part of the URL after `#`, which browsers never send
to a server — so whoever hosts the copy you used sees nothing about what you ranked. It opens the
**reading view** at `/v/`: the board with working links and hover cards, no editing chrome, and a
button to take a copy into the editor. That page fetches nothing and writes nothing to browser
storage. Anyone taking a copy has their own existing list set aside rather than overwritten.

This is the whole publishing story: no account, no upload, no server holding anyone's list.

To publish a list whose data lives in a separate file, put the JSON on the same site as the
editor and open it with `?data=https://your-site/lists/my-list.json`. Documents from other hosts
are refused by default — `SECURITY.md` explains why and how to allow a host you control.

## Covers

Point an item at a cover URL and press **Save covers**. The image is fetched once, shrunk to
about 20 KB, and kept in your browser's local store, keyed by a hash of its address — the same
cover used in five lists is stored once. Everything afterward renders from that copy.

This is what makes PNG export work. Browsers refuse to let a script read back a canvas
containing an image from another site, so an exporter that drew covers straight from the web
would fail at the moment of saving. Drawing from stored copies avoids the question entirely.

Storing also makes a list durable: cover URLs rotate, hosts change their sharing rules, and
neither reaches a list whose covers are already saved.

Hosts that refuse to share their images cannot be stored. Those covers still display on the page
(displaying never needs permission) and appear as labeled placeholders in the PNG only. Covers
you put in `covers/` yourself always work; that folder is gitignored so your images stay out of
the repo.

**On hotlinking:** the URLs rotate, and nobody has promised you a license to display retailer
cover art. Saving a copy locally is what the store does; publishing those copies is a separate
decision, and the repo ships no cover images — including for the demo on the landing page, which
hotlinks its covers like any other list.

That is a deliberate choice rather than an oversight. Committing the demo art would remove a
third-party dependency from the front page, but it would also mean redistributing cover art from a
public repository, which is the thing the paragraph above declines to do. The two costs are not
equal. What the dependency can actually cost is now bounded: a cover that fails to load shows the
book's title instead of an empty box, so the worst case is a demo that reads as plainly as it
looks. The demo URLs carry no `?time=` cache-buster — verified unnecessary against the live CDN,
with a control — so there is one less moving part to rot.

## Data format

See `data/example.json` and `ARCHITECTURE.md` §3. The short version:

```jsonc
{
  "schema": "booktier/v1",
  "title": "…",
  "tiers": [{ "id": "s", "label": "S", "color": "#ffbf7f" }],
  "items": [{
    "id": "primal-hunter", "tier": "s", "pos": 0,
    "title": "The Primal Hunter", "byline": "Zogarth",
    "href": "https://…", "image": { "src": "covers/primal-hunter.jpg" },
    "note": "one line for the hover card",
    "fields": { "hours": 84, "volumes": 12 }
  }]
}
```

`fields` is deliberately open. It is what keeps the schema from growing a column per use case.

## Hosting your own copy

It is static files — any host that serves a directory works. `HOSTING.md` has the response
headers worth setting, including a Content-Security-Policy that the smoke test enforces against
the running app, plus recipes for Cloudflare Pages, Netlify, GitHub Pages, nginx and Caddy.

`SECURITY.md` covers the trust boundaries, what the code does about untrusted documents, and
three residual risks to decide on before you host a public copy — the first being that `?data=`
lets anyone render their content on your domain.

## Roadmap

- Cover ingest: file upload and clipboard paste, downscaled and stored locally
- Tier editing in the UI (labels, colors, add/remove rows)
- CSV import with column mapping
- Optional compact URL state for small lists

## Not planned

- A backend, accounts, or hosting. This is a file you own.
- URL-encoded state as the primary share mechanism — see `ARCHITECTURE.md` §5 for why it does
  not survive items that carry real metadata.

## Project layout

```
index.html        landing page — GENERATED by tools/build-site.mjs, commit it
app/index.html    the editor
src/core          schema and placement, no DOM
src/render        the renderer shared by editor, preview and export
src/io            autosave, cover store, ?data= loader
src/editor        drag and drop, wiring
src/export        PNG renderer
src/site          landing page template, styles, generated demo CSS
data/example.json the starter list, and the source of the landing demo
tools             build scripts and the browser smoke test
```

`npm run build` regenerates `index.html`, `src/site/demo.css` and `src/render/board.css`.
`npm run check` fails if any of them is stale, and `npm run smoke` runs it before the browser
tests. Edit landing copy in `src/site/landing.template.html`, never in `index.html`.

## Credits and license

MIT. Built after reading nine other open-source tier list projects; `CREDITS.md` names each one
and what was taken from it.
