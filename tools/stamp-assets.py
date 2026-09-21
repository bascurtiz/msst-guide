#!/usr/bin/env python3
"""Stamp the shared assets with a content hash.

SUPERSEDED by ``tools/build.mjs``, which stamps the pages it renders, so the
stamps are always derived from the assets as they were at that moment — the
build-then-stamp ordering rule this script needed no longer applies. Kept for
reference. Do not run it against the repository root any more: those ``*.html``
files are generated. Run ``node tools/build.mjs`` instead.

Each page references ``assets/css/site.css?v=<hash>``, ``assets/js/site.js?v=<hash>``
and ``assets/js/search-index.js?v=<hash>``. The hash is the first eight hex digits
of the file's MD5, so it changes exactly when the file changes and never needs a
human to bump a counter by hand.

Run it last, after ``tools/build-search-index.py`` — stamping before the index is
rebuilt would pin the *old* index under a fresh-looking URL, which is the one
failure mode this replaces.

    python tools/stamp-assets.py
"""

import hashlib
import pathlib
import re

ROOT = pathlib.Path(__file__).resolve().parent.parent
ASSETS = ("assets/css/site.css", "assets/js/site.js", "assets/js/search-index.js")
PAGES = sorted(ROOT.glob("*.html"))


def digest(rel):
    return hashlib.md5((ROOT / rel).read_bytes()).hexdigest()[:8]


def main():
    stamps = {rel: digest(rel) for rel in ASSETS}
    for rel, dig in stamps.items():
        print(f"  {rel} -> ?v={dig}")

    changed = 0
    for page in PAGES:
        text = original = page.read_text(encoding="utf-8")
        for rel, dig in stamps.items():
            # match the asset reference and whatever stamp it currently carries
            text = re.sub(
                re.escape(rel) + r"\?v=[A-Za-z0-9._-]+",
                f"{rel}?v={dig}",
                text,
            )
            # a reference with no stamp at all
            text = re.sub(
                r'((?:href|src)="' + re.escape(rel) + r')(?=")',
                rf"\1?v={dig}",
                text,
            )
        if text != original:
            page.write_text(text, encoding="utf-8")
            changed += 1
            print(f"  stamped {page.name}")
        else:
            print(f"  {page.name} already current")

    print(f"\n{len(PAGES)} pages, {changed} rewritten")


if __name__ == "__main__":
    main()
