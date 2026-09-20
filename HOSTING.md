# Hosting a copy

booktier is static files. Any host that serves a directory works — no build step at deploy time,
no runtime, no server-side anything. Copy the repository (minus `node_modules/`) to your web root
and it runs.

URL layout:

| Path | What it is |
|---|---|
| `/` | Landing page. Generated from `src/site/landing.template.html` by `npm run build` — commit the generated `index.html`. |
| `/app/` | The editor. |
| wherever you put them | Exported lists. They are self-contained files; see the separate policy below. |

Run `npm run check` before deploying: it fails if the generated landing page or stylesheets are
stale relative to their sources. There is no build step to configure on the host — leave the build
command empty and the output directory at the repository root.

The rest of this document is about serving it *well*: the response headers worth setting, the one
policy that needs a second rule, and per-host recipes.

## Recommended response headers

```
Content-Security-Policy: default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' https: data: blob:; connect-src 'self' https:; font-src 'self'; frame-src 'self' blob:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'
Referrer-Policy: no-referrer
X-Content-Type-Options: nosniff
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Resource-Policy: same-origin
Permissions-Policy: camera=(), microphone=(), geolocation=(), interest-cohort=()
Strict-Transport-Security: max-age=31536000; includeSubDomains
```

That CSP is not aspirational — `tools/smoke.mjs` serves the app under exactly this policy,
drives the editor, and fails if the browser reports any violation. `index.html` also carries the
same policy as a `<meta>` tag, so the app is protected even on hosts that cannot set headers.
Header and meta policies both apply; the effective policy is the stricter of the two.

Why these values:

- `img-src` includes `https:` because covers legitimately come from other hosts, and `blob:`
  because stored covers render from local blobs.
- `connect-src` includes `https:` for `?data=` documents. Remove it if you disable that feature
  (see `SECURITY.md`), and the policy tightens to `'self'`.
- `frame-src blob:` and `'self'` cover the sandboxed preview iframe.
- `frame-ancestors 'none'` stops your copy being framed inside someone else's page. Only a
  header can set this — the meta tag cannot.

## Exported pages need a different rule

A page exported from booktier is deliberately one self-contained file, which means its styles are
inline. Served under the CSP above it will render unstyled. If you host exported lists on the same
site, give that path its own policy:

```
/lists/*
  Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'; img-src https: data:; frame-ancestors 'none'
```

Scripts stay forbidden — an exported page has none — so `unsafe-inline` here applies only to
styles, and the page still cannot execute anything.

## Host recipes

**Cloudflare (Workers static assets)** — this is what the dashboard sets up today when you
connect a Git repository, and the repo ships the two files it needs:

- `wrangler.jsonc` — names the project and points `assets.directory` at the repository root.
- `.assetsignore` — keeps `node_modules`, `tools/` and the markdown docs out of the upload.
  Without it the deploy tries to publish `node_modules` and fails: Cloudflare caps a single
  asset at 25 MiB, and `node_modules/workerd/bin/workerd` is over 120 MB.

Leave the build command empty. Cloudflare still runs `bun install` because a `package.json`
exists — that only pulls the Playwright devDependency used by the test suite and is harmless.

`_headers` (below) is honored on this path as well as on Pages.

**Cloudflare Pages / Netlify** — `_headers` ships in this repository already, so a connected
deploy picks it up with no configuration. It contains:

```
/*
  Content-Security-Policy: default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' https: data: blob:; connect-src 'self' https:; font-src 'self'; frame-src 'self' blob:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'
  Referrer-Policy: no-referrer
  X-Content-Type-Options: nosniff
  Permissions-Policy: camera=(), microphone=(), geolocation=()
```

**GitHub Pages** — cannot set response headers at all. The `<meta>` policy in `index.html` is
your CSP there, which covers everything except `frame-ancestors`. Acceptable for a personal copy;
use a host with header control if you care about framing.

**Apache / cPanel shared hosting (GoDaddy, Bluehost, and similar)** — upload the files to the
document root and put this in `.htaccess` beside them:

```apache
<IfModule mod_headers.c>
  Header always set Content-Security-Policy "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' https: data: blob:; connect-src 'self' https:; font-src 'self'; frame-src 'self' blob:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
  Header always set Referrer-Policy "no-referrer"
  Header always set X-Content-Type-Options "nosniff"

  # Exported lists carry their styles inline by design — give them their own policy.
  <FilesMatch "^lists/">
    Header always set Content-Security-Policy "default-src 'none'; style-src 'unsafe-inline'; img-src https: data:; frame-ancestors 'none'"
  </FilesMatch>
</IfModule>
```

Shared hosting works, but note what you give up: uploads are manual (FTP or the host's file
manager) on every change, there is no deploy from the repo, and `mod_headers` has to be enabled —
on some plans it is not, and the policy silently does nothing. Check for the headers with your
browser's network tab after the first upload rather than assuming they applied.

**nginx**

```nginx
location / {
    root /var/www/booktier;
    add_header Content-Security-Policy "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' https: data: blob:; connect-src 'self' https:; font-src 'self'; frame-src 'self' blob:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'" always;
    add_header Referrer-Policy "no-referrer" always;
    add_header X-Content-Type-Options "nosniff" always;
}
```

**Caddy**

```
your-site.example {
    root * /var/www/booktier
    file_server
    header {
        Content-Security-Policy "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' https: data: blob:; connect-src 'self' https:; font-src 'self'; frame-src 'self' blob:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
        Referrer-Policy "no-referrer"
        X-Content-Type-Options "nosniff"
    }
}
```

## Two decisions before you go public

1. **Use a dedicated origin.** Browser storage is shared across everything on an origin, so give
   booktier its own subdomain rather than a path on a site that runs other code.
2. **Decide what `?data=` should do.** It is the one feature that lets a stranger's content render
   on your domain. `SECURITY.md` lists the three options; picking "leave it on" is fine, but pick
   it deliberately.

## Files you do not need to deploy

`node_modules/`, `tools/`, `package.json` and the markdown docs are not used at runtime. Deploying
them is harmless; omitting them is slightly tidier.

## Updating

`git pull`, then re-upload. There is no build and no database, so there is no migration step.
Users' lists and covers live in their own browsers and are untouched by a deploy.
