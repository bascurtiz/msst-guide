# Hosting the guide

Two halves, and only one of them is in this repository.

```
reader → https://msst-guide.pages.dev    Cloudflare Pages
             │  _worker.js relays every request
             ▼
         the CMS (InStatic)              a Bun server with a SQLite database
             │  publishes plain HTML to its own volume
             ▼
         readers get files
```

- **The guide's content, layout and pages live in the CMS.** Nothing in this
  repository renders the site any more. Editing a file here does not change what
  a reader sees, and adding a page here does not add a page to the guide.
- **This repository is the front door.** `_worker.js` is a Pages Function that
  relays reader requests to the CMS; `robots.txt` and `sitemap.xml` are answered
  from this project because they belong to the address rather than to the
  content; `tools/deploy-pages.mjs` stages those four files and deploys them.
- **`/admin/` on the guide's address is a redirect**, not the editor: the CMS's
  session cookie and its CSRF origin check are both bound to its own hostname, so
  the editor has to be visited there. `_worker.js` sends `/admin/…` on to it.

## The relay

`_worker.js` is the only moving part on this side, and it does four things worth
knowing before you change it:

- **It never answers a page from this project's own assets.** The pages this
  repository used to hold are gone from `main`, but the rule stands: falling back
  to `env.ASSETS` would resurrect whatever a future commit puts there. It relays
  everything to the CMS instead. `tools/deploy-pages.mjs` refuses to bundle an
  `.html` file at all.
- **Old addresses are 301s.** `/data.html` → `/data`, `/index.html` → `/`, and so
  on for the five pages — inbound links and whatever Google indexed before the
  move use the `.html` form. The set is `PAGE_ROUTES` in the file itself, and it
  is checked against `sitemap.xml` at deploy time.
- **Only `/_instatic/` is cached**, because the CMS ships those files hashed and
  immutable. Pages carry the cache headers the CMS sets.
- **Headers are cleaned at the hop**: hop-by-hop headers, `content-encoding`,
  `content-length`, HSTS, and any `set-cookie` are dropped, and a `location` the
  CMS issues on its own hostname is rewritten to ours so the address bar stays on
  `msst-guide.pages.dev`.

The upstream host is an environment variable, `INSTATIC_ORIGIN`, defaulting to the
value in the file. **Moving the CMS to another host is that one variable**, not a
code change — set it in the Pages project's settings and the relay follows.

`tools/lib/pages-proxy.test.mjs` covers this file: the header hygiene, the
redirect rewrite, and that a 204/304 from the CMS is not turned into a 500. The
container is a stub, so the test never touches the network.

## Deploying this side

```bash
node tools/deploy-pages.mjs --no-deploy   # stage dist/ and run every check
node tools/deploy-pages.mjs               # stage, check, deploy
node tools/check-live.mjs                 # is the site a reader gets the guide?
```

`npx --yes wrangler@4 pages deploy dist --project-name msst-guide --branch main`
is what that second command runs. `.github/workflows/deploy-pages.yml` does the
same on a push that touches the relay or the host files, using two repository
secrets:

**The third command is the one that matters after a deploy.** Cloudflare serves
whatever it has, happily, so a relay that never made it into the deployment and a
CMS that is down both look like success from the dashboard. `check-live.mjs`
fetches the site as a reader would: the five pages, that the answer came from the
relay (the `x-msst-proxy` header a static page would not carry), an asset the CMS
has to serve, the legacy `.html` redirects, `/admin/`, `robots.txt` and
`sitemap.xml`. The workflow runs it after a real deploy, so a deploy that did not
take is a red run. Run it by hand after any CMS-side change too — it is the
fastest answer to "is the guide up?"

| Secret | Where it comes from |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` | A dashboard token with **Account · Cloudflare Pages · Edit** |
| `CLOUDFLARE_ACCOUNT_ID` | A zone's Overview page, the dashboard URL, or `npx wrangler whoami` |

Optionally, a repository *variable* `CLOUDFLARE_PROJECT_NAME` if the project is not
called `msst-guide`. Without the two secrets the workflow stages the bundle and
prints a notice instead of failing, so the repository stays deployable by hand.

Three things about the token are worth keeping, because they cost time to find:

- **Cloudflare Pages is not one of the token templates.** Create the token from
  **Start from scratch** and set the permission by hand to
  *Account · Cloudflare Pages · Edit*. (The builder calls the level *Write*; the
  API reference calls it *Edit*.) An account token works for Pages — this project
  deploys with one.
- **`--branch main` deploys to production only if `main` is the project's
  production branch.** On a Direct Upload project that value is not editable in
  the dashboard, only through the API:

  ```bash
  curl -s "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/pages/projects/msst-guide" \
    -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" | grep -o '"production_branch":"[^"]*"'
  ```

- **Do not add the `*.pages.dev` noindex rule** Cloudflare's own documentation
  suggests for preview URLs. This site's live address *is* a `pages.dev` one, so
  that rule would deindex the guide itself.

`robots.txt` and `sitemap.xml` are written by `tools/seo.py` — one place, both
files, so a domain change cannot half-happen. The stager checks they agree on the
host, and that every route the sitemap advertises is one the relay answers.

`_headers` applies to the two files Pages serves itself. The rules that used to
cover `/admin/` and `/assets/fonts/` were removed with the editor and the
self-hosted assets: both are now relayed from the CMS, whose own headers apply.

## The CMS side

InStatic is one Bun server — the editor, the content, the media and the publisher
in one process — backed by SQLite or Postgres, with the site's files on its disk.

- **The database and the uploads directory are the site.** Backing the site up
  means copying both: the SQLite file (or a Postgres dump) and
  `UPLOADS_DIR/uploads`. The published HTML is derived and can be regenerated.
- **The published pages are baked to disk** under `UPLOADS_DIR/published/current`
  when you press Publish, and swapped in atomically. That folder is what the relay
  serves, and it is also why the site can be moved to a static host later.
- **`PUBLIC_ORIGIN` must match the hostname the editor is reached on**, or the
  CSRF check rejects the login form with `Forbidden: invalid origin` — the trap
  that fires after a domain change.
- **`INSTATIC_SECRET_KEY`** is required before any AI provider key or TOTP seed
  can be saved; generate it with the CMS's own
  `bun run scripts/generate-secret-key.ts`.
- **Pin the image tag** (`ghcr.io/corebunch/instatic:<version>` rather than
  `latest`). The CMS is pre-1.0 and moving, and the editor breaking because
  upstream shipped something is not a way to spend a morning.
- **A community SEO plugin restores the `<head>`** the import drops (canonical,
  Open Graph, Twitter card, JSON-LD) — verified on the published HTML, not
  assumed. Per-page `description` and article JSON-LD need an authored SEO record
  before they appear.
- **The host is scripted.** `tools/provision-vm.sh` builds it end to end — swap,
  Docker, the firewall, the volume, the CMS behind Caddy with a Let's Encrypt
  certificate, and a systemd timer that backs the database up nightly — and
  `--check` verifies a host that is already running. That timer is on the same
  disk as the database, so it is not yet a backup that survives losing the VM.
- **Moving all of this to another host is a procedure, not a copy**: it has an
  order, and two of its steps are order-dependent. `admin/MOVING-THE-CMS.md` is
  the runbook — including which values travel (the database and uploads) and which
  are re-created (users, plugin installs, published files).

## What is not here any more

The repository used to render the guide: `src/pages/*.html` templates,
`content/pages/*.json` prose, `tools/build.mjs`, the search index, the asset
stamps, and a Sveltia CMS at `/admin/`. The CMS replaced all of it — it owns the
words, the layout and the media now.

**That pipeline is one tag away**: `git checkout legacy-static-pipeline`. It still
builds (`node tools/build.mjs`), and it is the only copy of the guide's text
outside the CMS's database — which is the reason to keep it and the reason
backups of that database matter more than they used to.
