# Rules for agents working in this repo

## The site is not built here

- The guide's content, layout and pages live in the CMS. This repository is the
  Pages relay in front of it, plus the docs for operating both.
- Editing a page, a stylesheet or a script here does not change the site. Do not
  add pages or assets to "fix" something a reader sees — it is a CMS edit.
- `_worker.js`, `_headers`, `robots.txt`, `sitemap.xml` and `tools/deploy-pages.mjs`
  are the whole deployment; `tools/check-live.mjs` checks the result where a
  reader meets it. Reads in `README.md`, operations in
  `admin/INSTATIC-HOSTING.md`.
- `robots.txt` and `sitemap.xml` are generated: edit `tools/seo.py`, not them.
- `tools/provision-vm.sh` builds the CMS's host, which is not a deploy: it cannot
  change what a reader gets, and it never runs in CI. `--dry-run` renders its
  configuration for inspection; `tools/lib/provision-vm.test.mjs` asserts what has
  to agree across those files (the port, the volume's name, the origin).
- `tools/compare-hosts.mjs` compares two CMS hosts, which is only ever a migration.
  Its job is the failure that looks like success — a page, a figure or a plugin that
  did not make it across — so a difference it reports is a real one to fix before
  the relay is switched. The migration is `admin/MOVING-THE-CMS.md`.
- The retired pipeline is at the tag `legacy-static-pipeline`. Never resurrect a
  file from it into `main` — the stager refuses a bundle containing an `.html`
  file, and that refusal is the point.

## Be to the point

- Answer in the fewest words that carry the decision. No preamble, no restating
  the question, no "let me look at that".
- Lead with the answer or the action. Give reasoning only when asked why, or when
  a decision genuinely hinges on it.
- Don't narrate the work ("I'm going to read X, then edit Y"), and don't recap it
  afterwards. Say what changed and what to do next, once.
- Bullets over paragraphs; one sentence per bullet.
- Surface a caveat only if missing it would cost the user time, money or data.
  Skip the "worth noting", "two loose ends", and "what I deliberately didn't do"
  sections unless they change the next action.
- No tables, headings or multi-part structure for a one-part answer.
- When the user asks for steps, give the steps and nothing else.
