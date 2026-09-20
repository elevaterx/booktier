# Security

booktier is a static site with no server, no accounts, and no database. Nothing a user types,
imports, or ranks leaves their browser. That removes most of the usual attack surface — there is
no session to steal, no API to abuse, no stored user records to breach — and concentrates what
remains into one question:

**booktier renders documents it did not write.** A tier list can arrive from an imported file, a
re-imported exported page, or a `?data=` link someone sent. Every one of those is attacker
controllable, and all of them end up as HTML on a page you host.

## Trust boundaries

| Input | Trusted? | Handling |
|---|---|---|
| The app's own code | Yes — you host it | Zero runtime dependencies; nothing is fetched from a CDN |
| A document imported from a file | **No** | Schema validated, fields normalized, everything escaped at render |
| A document from `?data=<url>` | **No** | https only, no credentials, size capped, content-type checked, then as above |
| An exported page re-imported | **No** | Only the embedded JSON is parsed; the surrounding HTML is never inserted into the DOM |
| Cover images | **No** | Scheme allowlisted; decoded as images only, never interpreted |

## What the code does about it

**Output escaping.** Every value interpolated into HTML goes through `escapeHtml`
(`src/render/page.js`). The exported page contains no executable script of its own — the only
`<script>` is `type="application/json"` holding the source document, with `<` escaped so the
document cannot close its own tag.

**Scheme allowlists, not blocklists.** Links are restricted to http, https and mailto
(`safeHref`); cover sources to http, https, `data:image/*`, and relative paths with no quotes or
traversal (`safeImageSrc`). Anything else becomes an empty string, and the renderer emits a plain
focusable element instead of an anchor. Tier colors are matched against a hex pattern before they
reach a style property, because that is the one value that lands in CSS.

**Bounded remote input.** `?data=` requires https (except localhost), rejects URLs carrying
credentials, sends `credentials: 'omit'` and `no-referrer`, times out, and refuses documents over
2 MB or with a non-JSON content type.

**Sandboxed preview.** The page preview renders inside `<iframe sandbox="">`, so a document that
somehow slipped past validation still gets no script execution, no storage access, and no reach
into the editor's origin.

**No inline code.** No inline event handlers, no inline `<script>`, and board styles ship as a
real stylesheet rather than an injected `<style>` block — so the app runs under a strict
Content-Security-Policy with no `unsafe-inline`. `tools/smoke.mjs` serves the app under the
policy in `HOSTING.md` and fails the build if the browser reports a single violation.

**Supply chain.** Zero runtime dependencies. The only devDependency is Playwright, used by the
smoke test and never shipped. No fonts, analytics, or scripts are loaded from third parties, so
there is no third-party origin that can change what your visitors run.

## Known residual risks

These are real and worth deciding about before you host a public copy.

**1. `?data=` lets anyone render content on your domain.** Someone can send a link to
`https://your-site/?data=https://their-host/list.json` and your domain will display their titles
and their links. The content cannot execute code, but it can carry misleading text and links to
anywhere — which is a defacement and phishing shape, wearing your domain name.

Pick one before going public:

- Leave it on, and accept that your domain can render other people's lists.
- Restrict it to hosts you control — edit `dataParam()` in `src/io/loadUrl.js` to check the
  hostname against an allowlist.
- Remove it — delete the `dataParam()` call in `boot()`. Import from a file still works.

**2. Cover URLs cause the viewer's browser to make requests.** A document can list cover URLs on
any https host, and viewing it will fetch them — which that host can log. Mitigated by
`no-referrer` and omitted credentials (so no cookies are sent and the host does not learn which
page requested it), but the request does happen.

**3. Browser storage is per-origin.** Lists and covers live in localStorage and IndexedDB for the
origin serving the app. Anything else you host on that same origin can read them. Host booktier
on its own subdomain if you run other things.

**4. Exported pages are ordinary HTML files.** One produced by this tool is safe by construction,
but a file someone hands you claiming to be an export is just HTML. Import it (which parses only
the embedded JSON) rather than hosting it unexamined.

## Reporting a vulnerability

Open a GitHub issue for anything low-risk. For something you would rather not post publicly, use
the repository's private vulnerability reporting.
