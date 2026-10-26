# Moving the CMS to another host

The CMS is the whole site from the editor's point of view: its database, its
media, its settings and its published files. Moving it is the one operation where
being out of order costs you the author's text, so this is written as a checklist
in dependency order — **nothing later is safe until the step before it is
verified**.

It is written for the Railway → Google Cloud move, but the shape is the same for
any host: export, stand up, import, verify, switch, retire.

## The rule that decides everything else

There are two ways to carry the site across, and **they are not interchangeable**:

| | **Site bundle** (InStatic's own export) | **Raw volume copy** |
|---|---|---|
| How | Data workspace → **Export site**, everything ticked | `tar` the whole `/app/storage` |
| Content, prose, tables, rows | yes | yes |
| Media originals + folder tree | yes | yes |
| Site shell (settings, classes, breakpoints) | yes | yes |
| Admin users and passwords | **no** | yes |
| TOTP seeds, AI provider keys | **no** (encrypted, and encrypted secrets never travel) | yes, **but only if `INSTATIC_SECRET_KEY` is copied verbatim** |
| Plugin packages and install state | **no** | yes |
| Audit log, sessions, per-user preferences | **no** | yes |
| Published HTML | **no** — re-rendered on the first publish | yes |
| Media variants (WebP ladder) | **no** — regenerated on the next upload/replace | yes |

So: the bundle is for the *site*; the raw copy is for the *instance*. This
project's editor needs one admin account and one plugin (the SEO one), so either
works — the bundle is cleaner and enough, and the raw snapshot is insurance worth
taking because the database is small.

**If you copy the volume raw, copy `INSTATIC_SECRET_KEY` with it.** Rotate or lose
that key and every encrypted value is unreadable: AI keys must be re-entered and
TOTP MFA re-enrolled. On the bundle path the key doesn't matter, because none of
those values are in the bundle.

There is a third way to fill a host, and it is the wrong one: InStatic's
**Super Import** converts a static site — HTML pages, linked CSS, images, fonts —
into editable pages, and the pages it would eat are sitting in this repository one
tag away. Don't. Those pages predate the CMS, so rebuilding from them silently
reverts every edit made in the CMS since the move, and the CMS's own published
HTML is no better a source, being derived output rather than content. The bundle
is the only copy that is both current and portable; **import the bundle.**

## 0. Before anything

- Find out which version the service is actually running, and **pin that** on the
  new host rather than `latest`. If the Railway service names a tag, that is the
  answer. If it follows `latest` — which is easy to end up doing and is exactly
  the case the wrong tag costs you — the running container knows, and Railway's
  own console tab is the way to ask it:

  ```sh
  grep '"version"' /app/package.json    # in the service's Console tab
  ```

  Put that version in `--image ghcr.io/corebunch/instatic:<version>`. Worth also
  noting while you are in there: `ls /app/storage` (`data`, `uploads`,
  `published`) and `du -sh /app/storage/data/cms.db /app/storage/uploads`, which
  tell you how much there is to carry and how big the bundle will be.
- Copy these values out of the Railway service's variables into a password
  manager: `INSTATIC_SECRET_KEY`, `PUBLIC_ORIGIN`, `DATABASE_URL`, `UPLOADS_DIR`,
  `PORT`. The last three are host-specific and will change; the key is the one
  that must not.
- Export the **site bundle**, with media and folders ticked: in the CMS admin,
  **Data workspace → Export site**. This is an InStatic feature and needs nothing
  from Railway's plan — in particular it is *not* the **Backups** tab, which
  snapshots the volume and is pro-tier. The bundle is the copy this runbook uses,
  it carries the content and the media, and it is re-exportable for as long as the
  old host is alive, so take it early — and keep the download somewhere that is
  neither the old host nor this repository. A bundle is the whole site's content,
  media and settings in one file, and this repository is public; `export/` and
  `site-bundle-*.zip` are ignored in case one lands in it anyway, which is a net,
  not a plan.
- Optionally, take a live-safe database snapshot too, which the app can do without
  being stopped:

  ```sh
  # in the container: writes a consistent copy, no locking
  bun -e "import { Database } from 'bun:sqlite'; const src = new Database('/app/storage/data/cms.db', { readonly: true }); src.exec(\"VACUUM INTO '/app/storage/data/snapshot.db'\");"
  ```

  Railway paths for this install: database `/app/storage/data/cms.db`, uploads
  `/app/storage/uploads`, volume mounted at `/app/storage`. **On the bundle path
  this is insurance, not the plan** — it is the *instance* (users, plugin install,
  AI key, TOTP seeds, published HTML) rather than the content, all of which is
  re-created in step 2 anyway, and the rollback in step 4 does not depend on it:
  Railway keeps a stopped service's volume for 30 days, and stopping is what step 4
  does. Getting bytes out of a web console is the awkward part; skip it unless the
  bundle export goes wrong, in which case this file plus the volume is the way
  back.

## 1. Stand the new host up (readers still on the old one)

Nothing here is visible to readers yet. Build it fully, and prove it works on its
own address **before** any traffic moves.

`tools/provision-vm.sh` is this whole section: the VM, swap, Docker, the firewall,
the volume, the CMS and Caddy with a TLS certificate, and the nightly backup. It
is idempotent — a second run is the upgrade path.

**There is an order here, and it is the address first.** The editor's address is
the VM's IP in sslip.io form — `34.71.12.9` becomes `https://34-71-12-9.sslip.io`
— and Caddy gets its certificate for exactly that name, so it has to be decided
before the instance exists. A domain of your own works the same way, as long as its
A record names this address.

```sh
gcloud compute addresses create msst-cms-ip --region=us-central1
gcloud compute addresses describe msst-cms-ip --region=us-central1 --format='value(address)'
# 34.71.12.9  ->  origin=https://34-71-12-9.sslip.io
```

The address is **regional**, so that region has to be the one the zone belongs to
(`us-central1-a` sits in `us-central1`) and has to be one of the free ones; an
address that is unattached, or attached to a stopped instance, is what gets billed.

So **if those two commands are not going to be run back to back** — a pause of a
day between reserving the address and creating the instance — release it and
reserve a new one on return:

```sh
gcloud compute addresses delete msst-cms-ip --region=us-central1
```

Nothing downstream refers to the number yet, so a different IP costs nothing but
re-deriving `origin`. Only while the provisioner has not run; once a certificate
exists for the old name, changing it is a config change (the script refuses it
without `--force-env`, and says why).

Then the instance — one command, which is the point. The provisioner reads its
arguments from the instance metadata when it is handed over as a startup script,
so `origin` is the address from above:

```sh
gcloud compute instances create msst-cms \
  --zone=us-central1-a --machine-type=e2-micro \
  --image-family=debian-12 --image-project=debian-cloud \
  --boot-disk-type=pd-standard --boot-disk-size=30GB \
  --tags=http-server,https-server --address=msst-cms-ip \
  --metadata-from-file=startup-script=tools/provision-vm.sh \
  --metadata=origin=https://34-71-12-9.sslip.io,image=ghcr.io/corebunch/instatic:<tag>,instatic-secret-key=<key>
```

It runs on first boot and takes a few minutes, most of it Let's Encrypt. Watch it
where it reports:

```sh
gcloud compute ssh msst-cms --command='sudo journalctl -u google-startup-scripts -f'
```

Or skip the metadata form and run the same script by hand on the box — which is
also how you rebuild a host that already exists — and get its progress and its
checklist straight back instead of through a log:

```sh
gcloud compute ssh msst-cms
sudo tools/provision-vm.sh --origin https://34-71-12-9.sslip.io \
     --image ghcr.io/corebunch/instatic:<tag> --key-file /root/instatic-key
```

`--dry-run <dir>` writes the configuration it would install and touches nothing —
it is worth running first, and it is what the script's tests drive. `--check`
verifies a finished install, which is this section's "prove it" step for the host
itself. Read the script's header for the flags and for what it does about the
secret key on a re-run.

The decisions it encodes, so they can be checked rather than taken on trust:

- Free-tier VM: `e2-micro`, Debian, **30 GB standard persistent disk** (the free
  allowance, and the disk's IOPS scale with its size), in `us-west1`,
  `us-central1` or `us-east1` — the only free regions, which is what the address
  above has to be reserved in.
- 1 GB of RAM is the number to respect: the CMS measures **~400 MB** steady
  (Railway metrics, 23 September 2026), and Debian plus Docker take ~250 MB. Hence
  the 2 GB swap file, so a publish — which renders every page at once — can spike
  without being killed.
- Firewall: 80 and 443, plus the SSH port. The same variable shape as Railway,
  with `UPLOADS_DIR` and the SQLite file both **under the mounted volume** at
  `/app/storage` — which is what lets step 0's snapshot commands and step 2's
  restore run here verbatim:

  ```txt
  DATABASE_URL=sqlite:/app/storage/data/cms.db
  UPLOADS_DIR=/app/storage/uploads
  STATIC_DIR=/app/dist
  PUBLIC_ORIGIN=https://<the new editor address>
  ```

- TLS: Caddy in front, per InStatic's own VPS/TLS guide. Without a domain of your
  own, a `<ip>.sslip.io` name resolves to the VM and Let's Encrypt will issue for
  it — `PUBLIC_ORIGIN` just has to match it **exactly**, or the login form is
  rejected with `Forbidden: invalid origin`. The script refuses to change that
  value under an existing `.env` for this reason.
- An **open** billing account, before any of the above. Compute Engine is
  unavailable without one — free is not the same as billing-free, and the
  always-free `e2-micro` is free *within* an active account's allowance. A closed
  account is what makes a project read `billingEnabled: False`, and the two
  commands that show it are `gcloud billing accounts list` (the `OPEN` column) and
  `gcloud billing projects describe <project>`. Reopening is a console action;
  there is no gcloud command for it.
- A billing budget alert. The always-free allowance is real but it is not
  unlimited: 1 GB/month of egress and 30 GB of disk are the two you can cross by
  accident. It is an alert and not a cap, so for a setup whose intended spend is
  zero set the amount low — €1 fires at 50% of it and again when the month's
  forecast crosses 100%, which is the tripwire rather than a spending limit:

  ```sh
  gcloud billing budgets create --billing-account=<id> --display-name=msst-cms \
    --budget-amount=1 --threshold-rule=percent=0.50 \
    --threshold-rule=percent=1.0,basis=forecasted-spend
  ```

  Two arguments have to be right or it fails on `INVALID_ARGUMENT: Request contains
  an invalid argument`: leave the **currency** off `--budget-amount` (it must be the
  billing account's own, and a mismatch is rejected with that unhelpful message —
  the account's currency is in `gcloud billing accounts describe <id>`), and
  `percent` is a **fraction** of the budget, so `0.50` is half.
- The nightly backup it installs is on the **same disk** as the database. That
  covers a bad edit or a corrupt file, not the loss of the VM, so a copy that
  leaves the box is still owed.

## 2. Import, and prove it on the new address

- First run the new instance's own setup (it creates the owner account) — the
  bundle carries no users, so there is always an account to make. On the raw path
  the existing users come with the database instead.
- Import the bundle: **Data** page → the **Import site** icon button beside
  **Export** in the tables panel header (icon-only, labelled by its tooltip). It
  reviews the bundle before committing, so nothing is written until you confirm.
  Two choices matter in that review:
  - strategy **Replace everything** — "wipe the local site and replace it with the
    bundle. Best for full restores"; **merge** is for adding to existing content.
  - for the compiled `site.css`, mode **Keep as stylesheet** rather than
    **Editable style rules**, so the file arrives byte-for-byte instead of being
    re-converted into a second copy of the 144 rules the bundle already carries.
  Read its log when it finishes; a bundle that half-imported still says "complete".
  Or restore the raw database and uploads instead.
- On the bundle path, re-create what it deliberately excludes: **reinstall the SEO
  plugin and re-enter its settings**, re-add the AI provider key, re-enrol TOTP,
  and invite the author.
- **Publish once** on the new host. Until you do, it has no published files — the
  bundle excludes them on purpose.
- Verify against the new origin directly, not through the relay. `tools/check-live.mjs`
  is deliberately **not** the tool here: it asserts relay behaviour — the
  `x-msst-proxy` header, the `.html` redirects, `/admin/` leaving this host — none
  of which exists until the relay points at this host. What is right is
  `tools/compare-hosts.mjs`, which asks the host readers are on now and the new one
  the same questions and reports the differences between the answers:

  ```sh
  curl -fsS https://<new origin>/health        # {"status":"ok","ts":…}
  node tools/compare-hosts.mjs --to https://<new origin>
  ```

  `--from` defaults to the relay's own default origin — the host readers are on
  right now — so the comparison needs one argument. It checks that each route
  answers 200 on both **with the same heading and about the same amount of text**,
  that the canonical, `og:url` and `og:image`'s host still name the guide's address,
  that media the old host serves is served here too, and that every asset the new
  pages reference actually loads. Renamed `/_instatic/` bundles come back as a note rather than a
  failure, because those names are content-hashed and a publish legitimately
  renames them.
- A route answering 404 means the import did not bring that page. A page that has
  no heading, or barely any text, means the site has not been published on this
  host yet — **until you press Publish, the new host has no pages at all.**
- Watch the canonical line in particular: the canonical, Open Graph and Twitter
  URLs are emitted by the SEO plugin from its own per-install site settings, so a
  fresh install that has not had them re-entered falls back to *its own* origin
  and quietly tells search engines to index the editor's address. That is the one
  import mistake that does not look wrong in a browser.

## 3. Switch the relay

- Set `INSTATIC_ORIGIN` in the Cloudflare Pages project to the new origin.
- **Redeploy the relay.** Pages environment variables are bound to a deployment,
  so changing the variable does nothing until a new one is published:

  ```sh
  node tools/deploy-pages.mjs
  ```

- Check it from the outside, which is the only place that counts:

  ```sh
  node tools/check-live.mjs
  ```

  It fails loudly if the pages stop coming from the relay, if the CMS is not
  serving an asset the page references, or if the legacy redirects broke.
- Confirm the *new* host is the one answering. Both origins serve identical pages,
  so the guide looking right proves nothing on its own: watch the new instance's
  request log while you load a page, or stop the old service (step 4) and load it
  again — if it still renders, the switch is real.

- Then do one real edit end to end: sign in at the new editor address, change a
  sentence, publish, and confirm it appears on the guide's address. That is the
  author's whole loop, and it is the last thing to test.

## 4. Stop paying, but keep the way back

- **Stop** the Railway service; do not delete it yet. Railway keeps volume data
  for 30 days after a Free or Trial plan expires, and that stopped service is your
  rollback: one `INSTATIC_ORIGIN` change and a relay deploy brings it back.
- Give it a few days of ordinary use. Then delete the service and the volume.
- Cancelling is not a migration step, it is the end of one. Doing it in this order
  is what makes the rollback cost a minute instead of a restore.

## 5. Confirm nothing still points at the old origin

This is the step that gets skipped, and a stale default is a trap that waits:

- **`_worker.js`'s `DEFAULT_ORIGIN`.** The relay falls back to it whenever the
  Pages variable is missing, so leaving it naming a deleted host means a future
  deploy with a lost variable serves 502s. Point it at the new origin, and run
  `node --test tools/lib/*.test.mjs`.
- The Pages project's `INSTATIC_ORIGIN` (and the account it lives in).
- The CMS's own `PUBLIC_ORIGIN` on the new host.
- The address the author bookmarks — he reaches the editor at the CMS's own
  address, so he needs the new one, or he'll meet a dead page and blame his
  password.
- `admin/INSTATIC-HOSTING.md`, whose header diagram and prose name the host.
- Railway's own leftovers: the old project, its volume and its custom domain, if
  one was ever attached.

## Where this sits

Done on 26 October 2026. The CMS runs on a Google Compute Engine `e2-micro` at
`https://34-171-14-163.sslip.io` (the sslip.io name for `34.171.14.163`), and the
reader path is `msst-guide.pages.dev` → relay → that host. The Pages project's
`INSTATIC_ORIGIN` and `_worker.js`'s `DEFAULT_ORIGIN` both name it, the site
bundle was imported and published there, and Railway's trial expired — its
volume is the rollback until Railway reclaims it after 30 days.

The topology in `admin/INSTATIC-HOSTING.md` says the same, so a host move starts
with both documents.
