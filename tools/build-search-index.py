#!/usr/bin/env python3
"""
Build the client-side search index for the guide.

SUPERSEDED by ``tools/build.mjs``, which builds the index from the rendered
pages as part of the one Node-only build the deploy relies on (a Python runtime
is not guaranteed in a build container). This copy is kept for reference and is
byte-compatible with the port: on the same input the two emit the same blocks.
Do not run it against the repository root any more — those ``*.html`` files are
generated. Run ``node tools/build.mjs`` instead.

Reads the five HTML pages, walks the article body, and emits
assets/js/search-index.js — a plain script that defines window.MSST_INDEX so
it works from a file:// path as well as over HTTP (a fetch() of each page
would not).

Shape of the emitted index (short keys keep the file small):

  {
    "generated": "2026-09-20",
    "pages": [{ "file": "data.html", "short": "Before you train",
                "title": "Before you train — requirements & datasets" }],
    "blocks": [                      # one entry per paragraph / list item /
      { "p": 1,                      #   table cell / code block / heading
        "sec": "Building a dataset", # section (<h2>) it lives in
        "id": "dataset",             # that section's anchor id ("" if none)
        "ctx": "Type 2 layout",      # nearest <h3> above it ("" if none)
        "kind": "h2" | "text",
        "x": "…" }                   # collapsed plain text
    ]
  }

Run after editing any page:

    python tools/build-search-index.py
"""

import datetime
import html
import json
import pathlib
import re
from html.parser import HTMLParser

ROOT = pathlib.Path(__file__).resolve().parent.parent
OUT = ROOT / "assets" / "js" / "search-index.js"

PAGES = [
    ("index.html", "Home", "Training Audio Source Separation Models — A Practical Guide"),
    ("data.html", "Before you train", "Before you train — requirements and datasets"),
    ("setup.html", "Setup & config", "Setup and configuration — the repository, commands and YAML"),
    ("training.html", "Training runs", "Training runs — from scratch, fine-tuning, local and cloud"),
    ("reference.html", "Reference", "Reference — troubleshooting, glossary and metrics"),
]

# Sub-trees that carry navigation or decoration, not content.
SKIP_TAGS = {"script", "style", "svg", "nav", "header", "footer", "head", "title", "meta",
             "button", "select", "option", "noscript"}
SKIP_CLASSES = {"toc", "pager", "crumbs", "skip", "progress", "backtop", "site-nav", "search-overlay",
                "drawer", "dlabel", "term-bar", "code-bar", "tree-bar", "copy", "chips", "cta", "flow-note",
                "header-actions", "switch", "brand"}
BLOCK_TAGS = {"p", "li", "td", "th", "pre", "figcaption", "dt", "dd", "blockquote",
              "h1", "h2", "h3", "h4", "h5", "h6"}
HEADING_TAGS = {"h1", "h2", "h3", "h4", "h5", "h6"}
VOID_TAGS = {"area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta",
             "param", "source", "track", "wbr", "path", "circle", "rect", "line", "g",
             "polyline", "polygon", "ellipse", "stop", "use", "text", "tspan"}


class Extractor(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.blocks = []            # finished blocks
        self.stack = []             # open block buffers: [tag, attrs, text]
        self.skip = []              # open tags inside a skipped sub-tree
        self.section = ("", "Overview")   # (id, title)
        self.context = ""

    # -- ignore navigation / decoration ------------------------------------
    def _skipped(self, tag, attrs):
        if tag in SKIP_TAGS:
            return True
        classes = dict(attrs).get("class", "")
        return bool(SKIP_CLASSES & set(classes.split())) if classes else False

    def handle_starttag(self, tag, attrs):
        if self.skip:
            if tag not in VOID_TAGS:
                self.skip.append(tag)
            return
        if self._skipped(tag, attrs):
            if tag not in VOID_TAGS:
                self.skip.append(tag)
            return
        if tag in BLOCK_TAGS:
            self.stack.append([tag, dict(attrs), []])
        elif tag == "img":
            self._text(" " + dict(attrs).get("alt", "") + " ")
        elif tag in ("br", "hr"):
            self._text(" ")

    def handle_startendtag(self, tag, attrs):
        if not self.skip:
            self.handle_starttag(tag, attrs)
            if tag in BLOCK_TAGS:
                self.handle_endtag(tag)

    def handle_endtag(self, tag):
        if self.skip:
            if tag in self.skip:
                while self.skip:
                    if self.skip.pop() == tag:
                        break
            return
        if tag in BLOCK_TAGS:
            for i in range(len(self.stack) - 1, -1, -1):
                if self.stack[i][0] == tag:
                    self._close(i)
                    break

    def handle_data(self, data):
        if not self.skip:
            self._text(data)

    def _text(self, data):
        if self.stack:
            self.stack[-1][2].append(data)

    def _close(self, idx):
        tag, attrs, parts = self.stack.pop()
        text = re.sub(r"\s+", " ", "".join(parts)).strip()
        # drop children that are already covered by their parent's text
        if self.stack and text:
            parent_text = re.sub(r"\s+", " ", "".join(self.stack[-1][2]))
            if text and text in parent_text:
                return
        if not text or not re.search(r"[A-Za-z0-9]", text):
            return
        if tag == "h2":
            self.section = (attrs.get("id", ""), text)
            self.context = ""
        elif tag == "h3":
            self.context = text
        if tag in HEADING_TAGS and self.stack:
            # a heading's text also belongs to the block around it
            self.stack[-1][2].append(" " + text + " ")
        self.blocks.append({
            "sec": self.section[1],
            "id": self.section[0],
            "ctx": self.context if tag not in HEADING_TAGS or tag == "h3" else self.context,
            "kind": "head" if tag in HEADING_TAGS else "text",
            "x": text if len(text) <= 1200 else text[:1200].rsplit(" ", 1)[0],
        })


def extract(path):
    parser = Extractor()
    parser.feed(path.read_text(encoding="utf-8"))
    parser.close()
    # a heading block keeps the *previous* heading as its context, so searching
    # a section title still shows the section it belongs to
    return [b for b in parser.blocks if b["x"]]


def main():
    pages, blocks = [], []
    for file, short, title in PAGES:
        idx = len(pages)
        pages.append({"file": file, "short": short, "title": title})
        found = extract(ROOT / file)
        # collapse the token stream into the compact tuple form
        for b in found:
            blocks.append([idx, b["sec"], b["id"], b["ctx"], b["kind"], b["x"]])

    payload = {
        "generated": datetime.date.today().isoformat(),
        "pages": pages,
        "blocks": blocks,
    }
    js = (
        "/* Generated by tools/build-search-index.py — do not edit by hand.\n"
        "   Rebuild after editing any page:  python tools/build-search-index.py\n"
        "   blocks: [pageIndex, section, sectionAnchor, subHeading, kind, text] */\n"
        "window.MSST_INDEX="
        + json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
        + ";\n"
    )
    OUT.write_text(js, encoding="utf-8")

    words = sum(len(b[5].split()) for b in blocks)
    print(f"  {len(pages)} pages, {len(blocks)} blocks, {words:,} words")
    print(f"  assets/js/search-index.js  {OUT.stat().st_size / 1024:.1f} KB")
    for i, p in enumerate(pages):
        n = sum(1 for b in blocks if b[0] == i)
        print(f"    {p['file']:<15} {n:>4} blocks")


if __name__ == "__main__":
    main()
