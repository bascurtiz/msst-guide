#!/usr/bin/env python3
"""
Generate sitemap.xml and robots.txt.

The site URL lives here in one place. If you deploy this guide somewhere other
than the domain below, change SITE and rerun:

    python tools/seo.py

(You will also need to update the canonical / Open Graph URLs in the five
<head> blocks — they are plain links, so a find-and-replace is enough.)
"""

import datetime
import pathlib

ROOT = pathlib.Path(__file__).resolve().parent.parent
SITE = "https://msst-guide.pages.dev"

PAGES = [
    ("", "1.0", "weekly"),
    ("data.html", "0.9", "monthly"),
    ("setup.html", "0.9", "monthly"),
    ("training.html", "0.9", "monthly"),
    ("reference.html", "0.8", "monthly"),
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
        f"Sitemap: {SITE}/sitemap.xml\n",
        encoding="utf-8",
    )

    print(f"  sitemap.xml  {len(PAGES)} URLs · {SITE}")
    print("  robots.txt   allow all + sitemap reference")


if __name__ == "__main__":
    main()
