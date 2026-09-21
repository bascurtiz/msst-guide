#!/usr/bin/env python3
"""
Fetch the self-hosted Montserrat files used by this site.

  assets/fonts/montserrat-latin.woff2        variable, weight 400-800, normal
  assets/fonts/montserrat-latin-ext.woff2    variable, weight 400-800, normal
  assets/fonts/montserrat-latin-italic.woff2 variable, weight 400-800, italic
  assets/fonts/montserrat-latin-ext-italic.woff2
  tools/fonts/Montserrat[wght].ttf           build-only, for tools/make-og-image.py
  tools/fonts/Montserrat-Italic[wght].ttf    build-only

Montserrat is licensed under the SIL Open Font License 1.1
(https://github.com/google/fonts/blob/main/ofl/montserrat/OFL.txt).
Rerun this script only when you want to refresh the font files; the
results are committed, so a normal build never needs the network.
"""

import pathlib
import re
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parent.parent
FONT_DIR = ROOT / "assets" / "fonts"
TOOLS_FONT_DIR = ROOT / "tools" / "fonts"

CSS_URL = (
    "https://fonts.googleapis.com/css2"
    "?family=Montserrat:ital,wght@0,400..800;1,400..800&display=swap"
)
UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/126.0 Safari/537.36"
)
GITHUB_TTF = (
    "https://raw.githubusercontent.com/google/fonts/main/ofl/montserrat/"
)

# Which "/* subset */" blocks to keep, per style.
WANTED = {
    "normal": {"latin": "montserrat-latin.woff2",
               "latin-ext": "montserrat-latin-ext.woff2"},
    "italic": {"latin": "montserrat-latin-italic.woff2",
               "latin-ext": "montserrat-latin-ext-italic.woff2"},
}


def fetch(url, headers=None):
    req = urllib.request.Request(url, headers=headers or {"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=60) as resp:
        return resp.read()


def download_woff2():
    css = fetch(CSS_URL).decode("utf-8")
    # Blocks look like:  /* latin */\n@font-face { ... font-style: normal; ... url(...) ... }
    blocks = re.findall(r"/\*\s*([a-z0-9-]+)\s*\*/\s*@font-face\s*\{(.*?)\}", css, re.S)
    FONT_DIR.mkdir(parents=True, exist_ok=True)
    for subset, body in blocks:
        style = re.search(r"font-style:\s*(\w+)", body)
        url = re.search(r"url\((https://[^)]+\.woff2)\)", body)
        if not style or not url:
            continue
        name = WANTED.get(style.group(1), {}).get(subset)
        if not name:
            continue
        data = fetch(url.group(1))
        (FONT_DIR / name).write_bytes(data)
        print(f"  {name:<38} {len(data) / 1024:6.1f} KB")


def download_ttf():
    TOOLS_FONT_DIR.mkdir(parents=True, exist_ok=True)
    for remote, local in (
        ("Montserrat%5Bwght%5D.ttf", "Montserrat[wght].ttf"),
        ("Montserrat-Italic%5Bwght%5D.ttf", "Montserrat-Italic[wght].ttf"),
    ):
        data = fetch(GITHUB_TTF + remote)
        (TOOLS_FONT_DIR / local).write_bytes(data)
        print(f"  tools/fonts/{local:<28} {len(data) / 1024:6.1f} KB")


if __name__ == "__main__":
    print("Webfonts -> assets/fonts/")
    download_woff2()
    print("Build-only TTFs -> tools/fonts/")
    download_ttf()
