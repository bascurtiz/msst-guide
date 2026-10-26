# MSST Guide — the front door

The guide itself — *Training Audio Source Separation Models*, the community
rewrite of Meskvlla33's original PDF — is no longer rendered from this
repository. Its words, layout and media live in a CMS, and this repository holds
what serves it to readers:

```
reader → https://msst-guide.pages.dev      Cloudflare Pages
             │  _worker.js relays every request
             ▼
         the CMS (InStatic)                a Bun server with a SQLite database
```

`admin/INSTATIC-HOSTING.md` is the operator's document: what the relay does, how
to deploy it, how the CMS is arranged and what has to be backed up. Read that
before changing anything here.

## What is in the repository

| Path | What it is |
| --- | --- |
| `_worker.js` | The Pages Function that relays this project to the CMS. The only moving part. |
| `_headers` | Response headers for the two files Pages serves itself. |
| `robots.txt`, `sitemap.xml` | Written by `tools/seo.py` — one place, both files. |
| `tools/deploy-pages.mjs` | Stages those four files into `dist/` and deploys them, checking them first. |
| `tools/check-live.mjs` | Checks the deployed site the way a reader meets it. Also the last gate of a deploy. |
| `tools/seo.py` | Regenerates `robots.txt` and `sitemap.xml`; `SITE` in it is the domain. |
| `tools/provision-vm.sh` | Builds the CMS's host — swap, Docker, firewall, Caddy TLS, the container, a nightly backup timer. Runs on the host, not in a deploy. |
| `tools/compare-hosts.mjs` | Compares two CMS hosts page by page and asset by asset, for the move between them. Not a deploy either. |
| `tools/lib/pages-proxy.test.mjs` | Tests the relay: header hygiene, redirect rewriting, status handling. |
| `tools/lib/deploy-pages.test.mjs` | Tests the stager: the bundle's contents, and the checks it makes. |
| `tools/lib/check-live.test.mjs` | Tests the live check against a stub of the site, one breakage per case. |
| `tools/lib/provision-vm.test.mjs` | Tests the host script by rendering its configuration and checking the things that have to agree across files. |
| `tools/lib/compare-hosts.test.mjs` | Tests the comparison against two stubbed hosts, one breakage per case. |
| `admin/MOVING-THE-CMS.md` | The runbook for moving the CMS to another host: export, stand up, import, switch, retire. |
| `admin/GUIDE-FOR-AUTHOR.md` | For the guide's original author — how to edit the text. |
| `assets/img`, `assets/fonts` | The original figures and Montserrat, now owned by the CMS. See `assets/README.md`. |

There are no dependencies, no build step and no framework. The deploy path is
Node alone, so a GitHub runner and an editor's laptop agree about everything;
`tools/seo.py` adds Python, and `tools/provision-vm.sh` adds a shell only on the
host it provisions.

## Deploying

```bash
node tools/deploy-pages.mjs --no-deploy   # stage dist/ and run every check
node tools/deploy-pages.mjs               # stage, check, deploy
node tools/check-live.mjs                 # is the deployed site the guide?
node --test tools/lib/*.test.mjs          # the relay, the stager, the live check
python tools/seo.py                        # after a domain change
```

The second command runs `npx --yes wrangler@4 pages deploy dist --project-name
msst-guide --branch main`. `.github/workflows/deploy-pages.yml` does the same on
a push that touches the relay or the host files, from two repository secrets
(`CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`) — and stages the bundle with a
notice instead of deploying when they are absent.

The stager refuses to emit a broken bundle rather than leaving the discovery to a
reader or a crawler: it will not include an HTML file, it requires the relay to
have a default origin and a default export, and it cross-checks `robots.txt` and
`sitemap.xml` — same host, and every route the sitemap advertises is one the relay
actually answers.

`tools/check-live.mjs` then checks the *deployed* site, which is a different
question: Cloudflare serves whatever it has, so a deploy that never landed and a
CMS that is down both look like success from here. It fetches the five routes and
checks each is the page it should be, that the answer came from the relay (the
`x-msst-proxy` header a hand-built page would not carry), that the CMS is really
serving an asset the page references, that the old `.html` addresses and `/admin/`
still redirect properly, and that `robots.txt` and `sitemap.xml` agree. The
workflow runs it after a deploy and fails on it, so a broken deploy is a red run
rather than a quiet 404 for a reader.

`INSTATIC_ORIGIN`, set in the Pages project, is which CMS the relay talks to.
Moving the CMS is that variable, not a code change.

## The CMS's host

The CMS runs on one small VM with a SQLite database and its media on a single
volume. `tools/provision-vm.sh` builds that host in one command — a swap file,
Docker, a firewall, the Compose project, Caddy with a Let's Encrypt certificate,
and a nightly backup of the database and the volume — and is idempotent, so
running it again with a newer `--image` tag is the upgrade.`--dry-run <dir>` shows exactly what it would install without touching anything, and `--check`
verifies a host that is already up. `tools/compare-hosts.mjs` is how a freshly built
host is proved to hold everything the current one does — page by page, figure by
figure — **before** the relay is pointed at it.

```bash
bash tools/provision-vm.sh --help            # the flags and what it does
bash tools/provision-vm.sh --dry-run /tmp/x \
  --origin https://<address> --image ghcr.io/corebunch/instatic:<tag>
```

`admin/MOVING-THE-CMS.md` is the procedure it implements, including what has to
be carried across by hand: the database cannot travel in the site bundle as a
usable copy of the instance, and the secret key must not change.

## The guide moved

The five rendered pages, `src/pages` templates, `content/pages` prose, the Sveltia
editor that used to sit at `/admin/`, and the render/search-index/stamp tooling
were retired when the content moved into the CMS. **Editing anything of the sort
here has no effect on the site**, so none of it remains on `main`.

It is all still in git, at the tag `legacy-static-pipeline` — worth keeping,
because it is the only copy of the guide's text outside the CMS's database:

```bash
git checkout legacy-static-pipeline         # the old pipeline, buildable
node tools/build.mjs                        # renders the five pages
```

The live site's editor is `/admin/` **on the CMS's own address** — the guide's
address redirects that path there — and saving publishes, without a rebuild.

## Credits

Bas Curtiz, unva, ZFTurbo, Kimberley Jensen, jarredou and becruily — see
`reference.html#credits` on the site. Original guide by Meskvlla33; this edition
is a community rewrite. Figures are reproduced from the original PDF.
