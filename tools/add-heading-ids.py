#!/usr/bin/env python3
"""Give every h2/h3 in the templates a stable id.

The share button next to each heading copies a link with that heading's anchor,
which only works if the anchor exists in the served HTML — an id added by script
after load is too late for the browser to scroll to on a fresh visit.

Ids are slugified from the heading text and never re-slugged once present, so a
shared link stays valid when a heading is reworded. Re-running is safe: headings
that already carry an id are left alone.

Run this after adding a heading by hand to src/pages/*.html; tools/build.mjs
carries the ids into the pages it renders.

    python tools/add-heading-ids.py
"""

import html as htmllib
import pathlib
import re
import unicodedata

ROOT = pathlib.Path(__file__).resolve().parent.parent
# headings live in the templates — the *.html files at the repository root are
# rendered from them by tools/build.mjs
PAGES = sorted(p for p in (ROOT / "src" / "pages").glob("*.html") if not p.name.startswith("_"))
HEADING = re.compile(r"<(h[23])(\s[^>]*)?>(.*?)</\1>", re.S)
MAX_SLUG = 48


def slug(text):
    text = re.sub(r"<[^>]+>", "", text)              # drop inline markup
    text = htmllib.unescape(text)
    text = unicodedata.normalize("NFKD", text)
    text = re.sub(r"[^\w\s-]", "", text).strip().lower()
    text = re.sub(r"[-\s]+", "-", text).strip("-")
    if len(text) > MAX_SLUG:                         # keep shared URLs readable
        text = text[:MAX_SLUG].rstrip("-")
        if "-" in text:
            text = text[:text.rfind("-")]
    return text or "section"


def main():
    total = 0
    for page in PAGES:
        text = page.read_text(encoding="utf-8")
        ids = set(re.findall(r'\bid="([^"]+)"', text))
        added = []

        def repl(m):
            tag, attrs, inner = m.group(1), m.group(2) or "", m.group(3)
            if re.search(r'\bid="', attrs):
                return m.group(0)
            base = slug(inner)
            candidate, n = base, 2
            while candidate in ids:
                candidate, n = f"{base}-{n}", n + 1
            ids.add(candidate)
            added.append(candidate)
            return f'<{tag} id="{candidate}"{attrs}>{inner}</{tag}>'

        new = HEADING.sub(repl, text)
        if new != text:
            page.write_text(new, encoding="utf-8")
        total += len(added)
        print(f"  {page.name}: +{len(added)} id(s)" + (f" — {', '.join(added[:4])}…" if len(added) > 4 else (f" — {', '.join(added)}" if added else "")))

    count = len(PAGES)
    print(f"\n{total} heading id(s) added across {count} template(s)")


if __name__ == "__main__":
    main()
