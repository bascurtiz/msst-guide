#!/usr/bin/env python3
"""
Generate sitemap.xml and robots.txt.

Both files belong to the address rather than to the content, which is why
_worker.js serves them from this Pages project instead of relaying them. The
site URL lives here in one place. If the guide moves somewhere other than the
domain below, change SITE and rerun:

    python tools/seo.py

The canonical, Open Graph and Twitter URLs are *not* here any more: the CMS
emits them, and its SEO plugin takes the domain from the site's own settings. So
a domain change is this file plus that setting — and `tools/deploy-pages.mjs`
will refuse to deploy the two files while they disagree about the host.
"""

import datetime
import pathlib

ROOT = pathlib.Path(__file__).resolve().parent.parent
SITE = "https://msst-guide.pages.dev"

# The routes the published site answers on, not the `.html` filenames this
# repository renders: since the content moved into the CMS, `_worker.js` relays
# these paths to it and sends `/data.html` on to `/data`. A sitemap listing the
# filenames would advertise five redirects instead of five pages.
PAGES = [
    ("", "1.0", "weekly"),
    ("data", "0.9", "monthly"),
    ("setup", "0.9", "monthly"),
    ("training", "0.9", "monthly"),
    ("reference", "0.8", "monthly"),
]


def main():
    today = datetime.date.today().isoformat()

    urls = "\n".join(
        "  <url>\n"
        f"    <loc>{SITE}/{page}</loc>\n"
        f"    <lastmod>{today}</lastmod>\n"
        f"    <changefreq>{freq}</changefreq>\n"
        f"    <priority>{prio}</priority>\n"
        "  </url>"
        for page, prio, freq in PAGES
    )
    (ROOT / "sitemap.xml").write_text(
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'
        + urls
        + "\n</urlset>\n",
        encoding="utf-8",
    )

    (ROOT / "robots.txt").write_text(
        "# MSST Guide — a community handbook for training audio source separation models.\n"
        "User-agent: *\n"
        "Allow: /\n"
        "\n"
        "# The content editor, not part of the guide. It lives on the CMS's own\n"
        "# address and refuses to be indexed there; what starts here is a redirect.\n"
        "Disallow: /admin/\n"
        "\n"
        f"Sitemap: {SITE}/sitemap.xml\n",
        encoding="utf-8",
    )

    print(f"  sitemap.xml  {len(PAGES)} URLs · {SITE}")
    print("  robots.txt   allow all + sitemap reference")


if __name__ == "__main__":
    main()
