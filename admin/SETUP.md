# Setting up the content editor

`/admin/` is the editor the guide's author uses. It is a static page — Sveltia
CMS, loaded from a CDN — and it edits by committing to this GitHub repository.
There is no server to run and nothing to install. What it does need is:

1. this site living in a **GitHub repository**, because the edits are commits;
2. the author having **write access** to that repository;
3. a way for the CMS to sign in as him, which is either a personal access token
   or a one-time OAuth setup (both below).

Until all three are true, `/admin/` shows a login screen that cannot sign in
yet. Everything else about the site works without it.

## 1. Put the site in a repository

Done: the site lives at <https://github.com/bascurtiz/msst-guide>, and
`admin/config.yml` already points the editor at it (`backend.repo`).

If you ever need to do it again from a fresh checkout, it is the ordinary
first push:

```bash
cd training-guide
git init -b main
git add .
git commit -m "MSST Guide"
git remote add origin https://github.com/bascurtiz/msst-guide.git
git push -u origin main
```

Then check that `backend.repo` in `admin/config.yml` names the repository you
actually pushed to — a wrong `repo` is the one misconfiguration that makes the
editor's login succeed and then fail on every save.

## 2. The quickest login: a personal access token

No infrastructure, works immediately, and it is the right choice if the author
is the only person who will ever edit.

He opens `https://<site>/admin/`, picks **Sign in with Token**, and follows the
link the dialog offers. That link opens GitHub's new fine-grained token form with
the name and **Contents: Read and write** already set; he still chooses
*Only select repositories → msst-guide* and an expiration, generates it, and
pastes the value in. The token is stored in his browser and reused from then on.
(The alternative is a classic token with the `repo` scope, if he prefers.)

Until step 3 is done, tell him to use **Sign in with a token** and *not* the
"Sign in with GitHub" button next to it: with no authenticator configured, that
button sends the browser to the OAuth client Sveltia falls back to for
Netlify CMS compatibility, which has no idea this site exists. It is not broken
as such — it is simply unconfigured, and step 3 is what configures it.

The trade-off: it is a credential sitting in a browser, it expires, and it
grants access to the whole repository rather than to this site's files. For a
single trusted editor that is usually an acceptable trade for the setup cost.

## 3. The nicer login: sign in with GitHub

This replaces the pasted token with an ordinary **Sign in with GitHub** button,
so the author never creates or renews a credential. It is optional, and it is
about half an hour of your time once, most of it waiting for a deploy.

Worth knowing before you start: **Sveltia cannot do this by itself for GitHub.**
The exchange needs a client secret, and a static page cannot keep one. GitHub has
no client-side PKCE flow for OAuth apps yet — Sveltia's own documentation marks it
*unimplemented*, waiting on GitHub — so an OAuth client of your own really is the
only way to get the button. That is the whole reason this step exists.

### Step 1 — deploy the authenticator

Sveltia publishes a small Cloudflare Worker that performs the exchange:
<https://github.com/sveltia/sveltia-cms-auth>. Deploy it with its own button:

<https://deploy.workers.cloudflare.com/?url=https://github.com/sveltia/sveltia-cms-auth>

That creates a Worker in your Cloudflare account named `sveltia-cms-auth`. Open it
in the dashboard and note its URL —
`https://sveltia-cms-auth.<your-workers-subdomain>.workers.dev`. You need it in
steps 2 and 4.

### Step 2 — register the Worker as an OAuth app

GitHub → **Settings** → **Developer settings** → **OAuth Apps** → **New OAuth
App** (<https://github.com/settings/applications/new>):

| Field | Value |
| --- | --- |
| Application name | `Sveltia CMS Authenticator` (anything) |
| Homepage URL | `https://msst-guide.pages.dev/` |
| Authorization callback URL | `<YOUR WORKER URL>/callback` |

That callback has to match exactly, `/callback` included, or GitHub refuses the
sign-in with a redirect-URI error. Then **Generate a new client secret** and keep
both values for the next step.

### Step 3 — give the Worker the credentials

The Worker's dashboard page → **Settings** → **Variables and secrets** → add:

| Name | Value |
| --- | --- |
| `GITHUB_CLIENT_ID` | the app's Client ID |
| `GITHUB_CLIENT_SECRET` | the app's secret — mark it **Encrypt** |
| `ALLOWED_DOMAINS` | `msst-guide.pages.dev` |

`ALLOWED_DOMAINS` is optional in the Worker's own documentation and worth setting
regardless: it stops anyone else pointing their CMS at your Worker at your
expense, and the Worker only releases a token to a page served from a hostname on
that list. It checks twice — once on the incoming request, once on the origin of
the reply — so it holds even if the first check is bypassed.

It is worth being precise about *which* hostname, because the check is against the
page the editor is running on, not against the repository. The editor sends its
own hostname, so `msst-guide.pages.dev` is the value that matters in production.
Two consequences: a **branch preview** deployment (`<hash>.msst-guide.pages.dev`)
and a **local** `python -m http.server` on `127.0.0.1` will both be refused with
*your domain is not allowed* — correct behaviour, and the reason the author should
be given the production URL rather than a preview one; and if you ever add a
custom domain, add it here too, or the button will stop working on it.

### Step 4 — point the CMS at the Worker

In `admin/config.yml`, under `backend`, set `base_url` to the Worker URL from step
1 — **with no trailing slash**, because the editor appends `/auth` and the OAuth
app's callback is `/callback`, and `…workers.dev//auth` is a path the Worker does
not answer — then delete the leading `#`:

```diff
 backend:
   name: github
   repo: bascurtiz/msst-guide
   branch: main
+  base_url: https://sveltia-cms-auth.<your-subdomain>.workers.dev
```

The line is already in the file, commented, with that same instruction next to it.
Commit it, and the button works from then on.

### What permissions GitHub will show the author

The authenticator asks GitHub for a scope on the author's behalf, and its default
is `repo,user` — which GitHub presents to the signer as *full control of private
repositories*, a startling thing to ask of someone who edits one public
repository. So `admin/config.yml` sets `auth_scope: public_repo` instead.

The editor appends `user` by itself, so the request that actually goes out is
`public_repo,user` — public repositories plus basic profile, which is everything
this site needs and nothing more. `auth_scope` accepts **exactly one** of two
values, `repo` or `public_repo`; a list like `public_repo,user` is rejected and
the editor refuses to load at all rather than quietly widening the request, which
is the right way round but a confusing failure if you hit it.

Two consequences worth knowing. If this repository ever becomes **private**,
change that value to `repo` — the narrow scope would be wrong, and the author's
sign-in would start failing on API calls rather than at the consent screen. And if
GitHub's consent screen ever mentions *private* repositories, the value has been
lost or misspelled: the Worker falls back to its own wider default for anything it
doesn't recognize, and writes that to its console log.

The author still needs a GitHub account with write access — that is unavoidable
for a CMS that edits a repository, and it is the price of having no server to run.

## 4. Publishing (a `pages.dev` host is static, and that is fine)

`pages.dev` is Cloudflare Pages, which serves static files. Nothing above needs
a server: `/admin/` is itself a static page that talks to the GitHub API from the
browser, and the only non-static piece in any of this is the OAuth worker in
step 3 — which the personal-access-token route does not need at all.

The one thing a static host *does* decide is **who renders the pages after a
save**. The author saves, the CMS commits `content/pages/*.json`, and something
has to turn that back into HTML. There are two ways to arrange that, and the one
that sounds obvious turns out to be the wrong choice here — which is worth
knowing before you click anything.

### Why the obvious route is the wrong one

Cloudflare's documentation is explicit: *"If you choose Direct Upload, you cannot
switch to Git integration later. You will have to create a new project."* So if
`msst-guide` was filled by dropping a zip into the dashboard — which is what this
project has done so far — then connecting the repository to Git means a **new
project**, and a new project cannot have a name that is taken. It would come back
as something like `msst-guide-a1b2.pages.dev`.

That is not cosmetic. The live URL is written down in several places: `site_url`
and `logo_url` in `admin/config.yml`, the canonical and Open Graph tags on every
page, `sitemap.xml`, `robots.txt` and the JSON-LD. A new URL means editing all of
them. (Deleting the old project first does free the name, and costs its
deployment history.) For one editor, that is a lot of churn to avoid two secrets.

### Option A (recommended) — keep the Direct Upload project, let the workflow publish

The project stays exactly as it is, served at `https://msst-guide.pages.dev`. Two
repository secrets let the included workflow deploy into it after every content
change. This is the same path Cloudflare documents for CI.

1. **Create the API token.** In the dashboard's left sidebar, **Manage account**
   (at the bottom) → **API Tokens** → **Create Token**. Name it
   (`msst-guide deploy`).

   The grid of cards you are then shown is a list of *templates*, not the limit of
   what a token can do, and **Cloudflare Pages is not one of the cards**. Choose
   the last one instead — **Start from scratch** — and set the permission by hand
   to **Account** · **Cloudflare Pages** · **Edit**. (Pages is marked compatible
   with account tokens in Cloudflare's own compatibility matrix; the permission is
   simply absent from the shortcut list.) Then   *Continue to summary* →
   *Create Token*, and copy the value, because it is shown once.

   This is the token this project deploys with, so the combination is known to
   work rather than merely documented: `wrangler` does accept an *account* token
   for Pages. Note the builder calls the level **Write** where the API reference
   calls the same permission **Edit**.

   For expiration, this is an unattended CI token: *No expiration* or a year is
   reasonable. If you date it, note the date somewhere — when it lapses the site
   stops updating (the workflow fails, so you get an email, but the guide quietly
   goes stale).

   *My Profile → API Tokens*, the older location, is the *user* token menu and is
   no longer in the sidebar; it is still reachable directly at
   <https://dash.cloudflare.com/profile/api-tokens>, and either kind of token
   works here with the same permission. Cloudflare's documentation for this exact
   CI setup points at the account one.
2. **Find the account ID**, by any of these: a zone's **Overview** page, in the
   **API** section of the right-hand menu; the 32-character hex string in the
   dashboard's own URL, right after `dash.cloudflare.com/`; or `npx wrangler
   whoami` on your machine, which prints it next to the account name.
3. **Add both to the repository.** GitHub → the repository → **Settings** →
   **Secrets and variables** → **Actions** → **New repository secret**:
   `CLOUDFLARE_API_TOKEN`, then `CLOUDFLARE_ACCOUNT_ID`. Those are the names the
   workflow reads (Cloudflare's own documentation uses the same two).
4. **Only if the project is not called `msst-guide`**: on the **Variables** tab,
   add `CLOUDFLARE_PROJECT_NAME` with the real name.
5. **Run it.** **Actions** → *Render the pages* → **Run workflow**. It renders,
   commits if anything changed, and deploys with
   `npx wrangler pages deploy dist --project-name msst-guide --branch main`.

Then open <https://msst-guide.pages.dev/admin/>. A sign-in screen means the
deployment reached production, and the editor is live. If the site is unchanged,
the deploy went to a preview branch instead — see the note below.

Without the two secrets the publish step prints a notice and exits cleanly, so
the workflow is safe to leave in place either way. And you can still do it by
hand, as today: `node tools/package-site.mjs`, upload the zip. That path always
works, but a save will not publish itself through it.

#### The production-branch trap

`--branch main` deploys to production only if `main` is the project's *production
branch*. On a Direct Upload project that value is not editable in the dashboard —
only through the API. Ask what it is:

```bash
curl -s "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/pages/projects/msst-guide" \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  | grep -o '"production_branch":"[^"]*"'
```

If it is not `main`, either point the workflow's `--branch` at what it is, or set
it — the one API call Cloudflare's documentation gives for exactly this:

```bash
curl -X PATCH "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/pages/projects/msst-guide" \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  -H "Content-Type: application/json" \
  --data '{"production_branch":"main"}'
```

### Option B — connect the repository to a *new* Pages project

Pick this only if a URL change is acceptable, or if you would rather have no
secrets and no upload ritual at all: Pages builds on every push, so a save
publishes itself.

1. Dashboard → **Workers & Pages** → **Create application** → **Pages** →
   **Connect to Git**; authorise the Cloudflare GitHub App for
   `bascurtiz/msst-guide` when it asks.
2. Choose the repository, and branch `main`.
3. Build settings: **Framework preset** *None*, **Build command**
   `node tools/package-site.mjs --no-zip`, **Build output directory** `dist`,
   **Root directory** left empty.
4. Add an environment variable `NODE_VERSION` = `20`, unless the build image's
   default is already that or newer.
5. **Save and Deploy**, then deal with the URL as described above.

The build command is the packager, so Pages publishes the site-only subset (the
five pages, `assets/`, `admin/`) rather than the whole repository — the same
bundle a direct upload produces, minus the zip. Pointing the output directory at
the repository root instead would also publish `src/`, `content/`, `tools/` and
the source fonts.

With this route the Action's render-and-commit becomes redundant — it renders
identical pages into the repository. Harmless, and still useful as a check and
for anyone browsing the repository; delete its "Commit the rendered pages" step
if you would rather not have a bot commit per edit.

### Keeping the editor out of search

The editor is a real page at `/admin/`, so it is excluded twice: `Disallow` in
`robots.txt`, and `X-Robots-Tag: noindex, nofollow` in `_headers` for crawlers
that ignore robots.txt. `_headers` is read by Pages only and is ignored
everywhere else, so it is safe to keep in the repository.

One caution if you go reading Cloudflare's documentation: it suggests a `_headers`
rule that applies `X-Robots-Tag: noindex` to `*.pages.dev`, to keep preview URLs
out of search results. Do **not** add it here — this site's live URL *is* a
`pages.dev` address, so that rule would deindex the guide itself.

## 5. Forward the steps to the author

Once the three things above are true, give him these — **`GUIDE-FOR-AUTHOR.md`**,
which is written for him rather than for a developer, or a link to it on GitHub:

<https://github.com/bascurtiz/msst-guide/blob/main/admin/GUIDE-FOR-AUTHOR.md>

A checklist for you beforehand:

1. **Publish once** (see §4) so `/admin/` exists on the live site. Until then the
   editor URL shows the guide itself, because the host falls back to the home page
   for a path it does not have — and the deployed bundle currently predates the
   editor.
2. **Add him as a collaborator with write access**: the repository page →
   *Settings* → *Collaborators and teams* → *Add people* → his GitHub username or
   email → role **Write**. A public repository grants read, not write, so this is
   required for a save to be accepted — check the role reads *Write*, because the
   form's default on a public repository is not necessarily it.

   He still has to **accept** the invitation before it takes effect, and it
   expires after seven days. If the email does not reach him, the *Pending
   invite* row has a copy button that gives you a link to send him directly.
3. **Send the editor URL**, <https://msst-guide.pages.dev/admin/>, and tell him to
   use *Sign in with a token* — that is step 2 of his guide, and it needs nothing
   from you. Do the OAuth worker in §3 only if you want him on the button instead.

Neither of the two guides in this folder is published: the packager stages only
`admin/index.html` and `admin/config.yml` from `admin/`, so `/admin/` on the live
site is the editor and nothing else.

## What the author can and cannot change

Editable: every paragraph, list item, sub-heading, card title, label and
figure caption on all five pages, plus **images** — the editor's media library
writes an upload to `assets/uploads/` and the rendered path is verified by the
build, so a mistyped filename fails the save instead of publishing a broken
image.

Not editable, by design: the SVG diagrams, code samples and command blocks, the
tables, the chunk-size calculator, the sidebar, the table of contents, the
"next chapter" links and the page footer. Those carry layout and data the
editor cannot represent safely, so they stay in the templates.

Two consequences worth knowing:

- **Renaming a chapter heading does not rename it in the sidebar or the "next"
  pager** — those are template markup. Ask for a code change if a chapter is
  being renamed for real.
- **A paragraph keeps its styling.** Each editable block is tied to a styled
  slot (an intro line stays an intro line); the editor cannot invent new
  styling, and the build refuses to run if a slot and its text ever disagree.
