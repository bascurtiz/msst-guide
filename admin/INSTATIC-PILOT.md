# Pilot: could InStatic run this site?

A decision document, not part of the shipped setup. Nothing in here changes the
live site, the repository, the author's editor or the deploy — the pilot is a
separate deployment on its own URL that you can delete afterwards.

The question it answers: **can InStatic import this site faithfully enough to be
worth replacing the current pipeline?** It is not a CMS swap. InStatic is a
self-hosted Bun server whose database is the source of truth, and it publishes
its own HTML — so adopting it retires `tools/build.mjs`, the slot markers,
`content/pages/*.json`, `admin/` (the Sveltia editor) and the CI deploy.

## What its documentation already tells us

Read from `docs/features/site-import.md` and the repo README, before spending any
time on a deploy. The good news first:

- **Pages.** One per `.html` file, with the slug taken from the path
  (`setup.html` → `setup`). Intra-site `<a href>` links are rewritten to internal
  page references, and `id`, ARIA and `data-*` attributes are preserved — so the
  anchors our table of contents and the build's reference check depend on survive.
- **The stylesheet.** Each linked sheet imports either as editable style rules
  (default) **or kept verbatim as a page-scoped file**. The second option matters:
  it means the 26 KB design system can come across byte-identical instead of being
  converted into framework tokens. See "the one choice that decides the pilot".
- **Colours, fonts and media.** `:root` colour custom properties become palette
  tokens; self-hosted `@font-face` families come across with their woff2 files;
  images and unreferenced media are uploaded.
- **Scripts.** Executable inline scripts *and* linked JS files are imported, with
  their order derived from every page's document order. That is what the theme
  switch, the search overlay, the VRAM calculator and the Copy buttons run on.
- The whole import is one atomic commit — a single `Cmd+Z` reverts it.

And the part that matters most, because it is the work we would have to redo:

- **The `<head>` is not imported.** The importer parses the body and derives a
  title and a slug. So the canonical link, the Open Graph and Twitter cards, the
  JSON-LD graph, `theme-color`, the icon links, the font `preload`, the `?v=`
  asset stamps, `robots.txt`, `sitemap.xml` and `_headers` are ours alone and do
  not come across. The SEO layer would have to be rebuilt in InStatic's own site
  settings and templates — and `_headers` is host configuration that InStatic has
  no concept of, so it stays with whoever serves the HTML.
- **`@layer`, conditional local `@import` and arbitrary external `@import` cannot
  be modeled.** They surface as warnings rather than being dropped silently.
  Keeping the stylesheet as a file sidesteps this entirely.

## The one choice that decides the pilot

In the Review step, set the import mode for `assets/css/site.css` to **keep as a
file** rather than converting it. Converting is the interesting long-term option —
it is what makes the design editable on the canvas — but it rewrites a hand-built
system into generated tokens and classes, and any drift from a conversion is
indistinguishable from a bug in the rest of the import. Keep it as a file first,
prove the rest works, and try a second import against a throwaway site if you want
to see what conversion does.

## The pilot, step by step

1. **Deploy InStatic.** The SQLite template on Railway, about two minutes, no
   terminal: <https://railway.com/deploy/instatic-cms-sqlite>. Create the admin
   account when it asks, and note the URL.
2. **Build the bundle.**

   ```
   node tools/package-site.mjs --no-zip
   node tools/prepare-instatic-bundle.mjs
   ```

   The first stages the deployable site into `dist/`; the second copies it to
   `dist-instatic/` with the cache-busting `?v=<hash>` stamps removed from every
   asset reference, skips `admin/` (the editor would otherwise import as a page)
   and skips the host-level `_headers`, `robots.txt` and `sitemap.xml`.

   **The stamps are not cosmetic.** Our build appends them to `href`/`src`
   (`tools/build.mjs`), and our own reference checker strips them before
   resolving — but InStatic resolves each `<link href>` against the dropped file
   paths, so `assets/css/site.css?v=61c969be` matches nothing and the import
   reports *"Stylesheet isn't linked by any imported page"*. First attempt at
   this pilot produced exactly that: 5 pages, 15 media, 5 scripts, and the
   stylesheet in the **Can't import** bucket, which would have arrived unstyled.
3. **Import it.** In InStatic: `Cmd+K` (or the workspace actions) → **Site
   Import** → drop the *contents* of `dist/` (the five pages plus `assets/`) →
   **Review**, setting the stylesheet mode as above → read the warnings pane →
   Conflicts (an empty site has nothing to conflict with) → Import.
4. **Test against the live site**, page by page, at desktop and phone widths:
   - Slug and title on all five pages.
   - Overall design parity — colours, type, spacing.
   - Code blocks: do the `cmd`/`f`/`ph`/`c` colours survive, and do the Copy
     buttons still work?
   - The **dark/light switch** — and the browser scrollbars following it.
   - The **search overlay** — open it with `/` and search a phrase from another
     page. This is the first thing I expect to suspect: our pages load their
     scripts with a `?v=` query string, and if the importer resolves linked JS by
     path alone, a cached-busting query is exactly the kind of thing that stops a
     file being matched.
   - The **VRAM calculator** in the YAML chapter — change a field, get a verdict.
   - **Montserrat**, not a fallback — this also proves the self-hosted fonts came
     across.
   - Then the known gap: view-source the *published* page and compare the `<head>`
     with the live one. Count what is missing rather than being surprised by it.
5. **Report back.** Paste the warnings list and name any page that looks wrong. I
   can read the imported pages and their head from here and tell you what is
   recoverable in InStatic and what would need re-authoring.

## Result of the first pilot — 22 September 2026

Ran on a Railway SQLite install at `msst-guide.up.railway.app` from the bundle
`tools/prepare-instatic-bundle.mjs` produces. Stylesheet kept as a file, Core
Framework set to **None**. Verified on the published pages, not inferred from the
editor.

**Survived:**

- All five pages on the right routes (`/`, `/data`, `/setup`, `/training`,
  `/reference`); unknown paths 404.
- The stylesheet, kept verbatim and republished as its own hashed bundle
  (`/_instatic/css/userStyles-….css`) — no framework CSS, no conversion drift.
- Self-hosted Montserrat, `@font-face` and all.
- All three scripts per page: the inline theme init, `search-index.js`, `site.js`.
- The dark/light switch — and `color-scheme` follows it, so the scrollbars flip
  with it.
- Search: 14 hits across 5 sections for a cross-page term, with section context.
- The chunk-size/VRAM calculator, including `hop_length` moving the VRAM verdict
  (chunk 197,632 → 42,460 on the same card).
- Layout, callouts, tables, meters, chips, TOC — the design system renders as
  authored.

**Lost, as its docs predicted:**

- The entire `<head>`, at import: canonical, `og:*` (the OG image included), the
  Twitter card, JSON-LD (zero blocks), `theme-color`, the icon links, the font
  `preload`, the robots directive. InStatic derives its own title and nothing else.
  **Recoverable — see below.**
- `robots.txt`, `sitemap.xml`, `_headers` — host-level files it does not model.
- The `?v=` cache stamps, replaced by content-hashed bundles. That part is an
  improvement rather than a loss.

### The head is recoverable: `WYRE-AI/instatic-plugin-seo`

A community plugin puts back what the import dropped. Verified on the published
HTML, not taken on trust:

| Tag | After installing the plugin |
| --- | --- |
| `<link rel="canonical">` | ✓ per page — `/`, `/setup`, `/reference` each carry their own |
| `og:type`, `og:title`, `og:url`, `og:image`, `og:site_name` | ✓ |
| `twitter:card`, `twitter:title`, `twitter:image` | ✓ |
| `Organization` JSON-LD with name, url and logo | ✓ |
| `<meta name="description">` | ✗ until a site-wide description or per-page SEO text is authored |
| Per-page `Article` / `BlogPosting` JSON-LD | ✗ until a page has an authored SEO record |
| `<link rel="icon">` | not the plugin's job — set it under Site identity |

So the SEO layer is a settings task rather than a rewrite, and the strongest
argument against switching mostly evaporates. What is genuinely gone:
`robots.txt`, `sitemap.xml` and `_headers`, which are host-level and have no
equivalent in a database-backed publisher.

Getting the plugin in was its own detour, worth recording because its packaging is
unusual:

- There is no release asset, and the plugin SDK is **not on npm** — the CLI lives
  inside the Instatic repository. Building therefore needs Bun *and* a checkout of
  the CMS, which the plugin's own `bun run setup` vendors into `.instatic/`.
- GitHub's "Download ZIP" is the *source*: no `package.json`, so `bun install` has
  nothing to work with and the upload fails with *"Plugin package is missing
  plugin.json"*. Build from a clone instead.
- The CLI's final step shells out to the `zip` binary, which Windows does not ship.
  The build dies *after* `dist/` is complete, so zip it by hand — naming the
  entries keeps `plugin.json` at the archive root:
  `tar -a -c -f ..\<id>.plugin.zip plugin.json admin server`.
- Descriptions are clipped to 160 characters, authored or not, and the plugin
  emits a minimum four-tag block on **every** page — installing it changes the
  published HTML site-wide.

**Friction to budget for** — each of these cost time on the first run:

- The `?v=` stamps break the import outright: `assets/css/site.css?v=61c969be`
  matches no dropped file, so the sheet is reported as unlinked and the site
  arrives unstyled. `tools/prepare-instatic-bundle.mjs` exists for this.
- Routes are not inferred usefully: `index.html` became `/index`, and the starter
  "Home" page already owned `/`, so the guide's home page landed on `/index-2`
  until the starter page was deleted and the slug changed.
- Switching a stylesheet's import mode **resets** the route edits already made in
  that step. Set the mode first, routes last.
- Publishing needs a live session. A stale session makes **Publish all** on the
  dashboard do *nothing* — no error, no toast — while the console shows `401` on
  `/api/cms/me`. The Site workspace's **Publish** works, and signing in again
  fixes the dashboard button.
- Renaming the Railway domain after first boot produces `Forbidden: invalid
  origin` on the setup form until `PUBLIC_ORIGIN` matches the new hostname.

## How to judge it

**Adopt** if design parity holds, the scripts all work, and you are willing to run
a server: a paid Railway (or Render/VPS) plan, backups of the database *and* the
uploads volume, and periodic updates. The head — the strongest argument against
switching — turned out to be one plugin plus three settings; `robots.txt`,
`sitemap.xml` and `_headers` are the only real casualties. The author's life gets
simpler in one real way too: an account on your server instead of a GitHub invite
and the OAuth dance.

**Stay** if the design drifts in ways you would have to re-tune, if the search or
calculator break in ways that mean rewriting them as InStatic modules, or if the
server itself is the thing you do not want. In that case the cheaper answer to
"the editor felt restricted" is to widen the current CMS instead: tables become
editable, sections gain free-form blocks, the toolbar gains links and lists.

Also worth weighing: InStatic is pre-1.0 and moving quickly. A migration now buys
a moving target, and its import tooling is the part most likely to improve.

## What the pilot does not touch

The repository, the live site at `msst-guide.pages.dev`, the Sveltia editor, the
author's guide and the Cloudflare deploy are all unaffected. Stopping the pilot is
deleting the Railway service.
