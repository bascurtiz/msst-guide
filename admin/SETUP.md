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

This gives the author an ordinary **Sign in with GitHub** button, and the token
never leaves the OAuth exchange.

1. **Deploy the authenticator.** Sveltia publishes one:
   <https://github.com/sveltia/sveltia-cms-auth>. Follow its README — it runs on
   Cloudflare Workers, and its one-click deploy button gives you a URL like
   `https://sveltia-cms-auth.your-subdomain.workers.dev`.
2. **Register a GitHub OAuth app** at <https://github.com/settings/developers>
   ("New OAuth App"), with the authorization callback URL set to
   `<your worker url>/callback`.
3. **Give the worker the credentials** from that app (its `GITHUB_CLIENT_ID` and
   `GITHUB_CLIENT_SECRET`).
4. **Point the CMS at the worker**: in `admin/config.yml`, uncomment
   `base_url` and set it to your worker URL.

One set-up step, then it behaves like any other "sign in with GitHub" button.
Note that the author still needs a GitHub account with write access — that is
unavoidable for a CMS that edits a repository, and it is the price of having no
server to run.

## 4. Publishing (a `pages.dev` host is static, and that is fine)

`pages.dev` is Cloudflare Pages, which serves static files. Nothing above needs
a server: `/admin/` is itself a static page that talks to the GitHub API from the
browser, and the only non-static piece in any of this is the OAuth worker in
step 3 — which the personal-access-token route does not need at all.

The one thing a static host *does* decide is **who renders the pages after a
save**. The author saves, the CMS commits `content/pages/*.json`, and something
has to turn that back into HTML. There are two ways to have that happen; pick one.

### Option A — connect the repository to Pages (recommended)

If the Pages project is connected to the GitHub repository, Pages builds on every
push, so a save publishes itself. Its build image has Node, which is all this
needs:

| Setting | Value |
| --- | --- |
| Framework preset | None |
| Build command | `node tools/package-site.mjs --no-zip` |
| Build output directory | `dist` |
| Environment variable | `NODE_VERSION` = `20` or newer, if the default is lower |

The build command is the packager, so Pages publishes the site-only subset (the
five pages, `assets/`, `admin/`) rather than the whole repository — the same
bundle the direct upload uses, minus the zip. The output directory is `dist` for
exactly that reason: pointing it at the repository root would also publish
`src/`, `content/`, `tools/` and the source fonts.

With this in place a save is live in about a minute, and the GitHub Action's own
render-and-commit becomes redundant — it renders identical pages into the
repository. Harmless, and still useful as a check and for anyone browsing the
repository; delete its "Commit the rendered pages" step if you would rather not
have a bot commit per edit.

### Option B — keep uploading the folder yourself

If you fill the project by direct upload (a zip, or `wrangler pages deploy`), the
repository is *not* connected to it, so **a save does not change the live site by
itself** — not the CMS's commit and not the Action's. Two ways to close that gap:

- **Automate it.** Add two repository secrets and the included workflow will
  publish for you after every content change:

  | Secret | Where to get it |
  | --- | --- |
  | `CLOUDFLARE_API_TOKEN` | Cloudflare dashboard → My Profile → API Tokens → *Cloudflare Pages: Edit* |
  | `CLOUDFLARE_ACCOUNT_ID` | The dashboard URL, or `npx wrangler whoami` |

  Optionally also a `CLOUDFLARE_PROJECT_NAME` repository *variable* if the Pages
  project is not called `msst-guide`. Without the two secrets the step prints a
  notice and exits cleanly, so the workflow works either way.

- **Or do it by hand.** `node tools/package-site.mjs`, then upload the zip (or
  `dist/`) again. The packager always includes `admin/` and refuses to emit a
  bundle with a broken reference in it, so the editor cannot be left behind by a
  forgotten folder.

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
