# What is left in here, and why

Two folders, kept deliberately:

- **`img/`** — the figures, extracted from the original PDF. The CMS holds its own
  copies in its media library, imported from here on 22 September 2026, but those
  live on one volume with the rest of the site. These are the only other copy of
  the originals.
- **`fonts/`** — Montserrat (SIL OFL 1.1) as self-hosted, subset woff2: latin and
  latin-ext, variable weight 400–800. Same reasoning, plus the licence file's
  requirement to keep the attribution with the files.

Everything else that used to be under `assets/` — `css/site.css`,
`js/site.js`, `js/search-index.js` and the (empty) `uploads/` — was deleted with
the pipeline that shipped it. The CMS stores its own copies now and republishes
them under `/_instatic/…`, so a file here would be a snapshot that looks
authoritative while having no effect on the site. Same for the pages, the
templates and the prose: see `admin/INSTATIC-HOSTING.md` and the
`legacy-static-pipeline` tag.
