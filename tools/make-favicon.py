#!/usr/bin/env python3
"""Render PNG fallbacks for the site favicon from the same waveform mark used
in the header (assets/img/favicon.svg).

Draws the 24x24 path supersampled 16x, then downsamples to the required sizes
so the strokes stay smooth at 32 px.

    python tools/make-favicon.py
"""
from pathlib import Path

from PIL import Image, ImageDraw

OUT = Path(__file__).resolve().parent.parent / "assets" / "img"

# the path from the header logo, in a 24x24 box:
# M2 14 h2.2 l1.6 -6 l1.8 10 l2 -14 l2 16 l1.8 -9 l1.6 4 H22
POINTS = [
    (2, 14), (4.2, 14), (5.8, 8), (7.6, 18), (9.6, 4),
    (11.6, 20), (13.4, 11), (15.0, 15), (22, 15),
]
BG = (20, 22, 26)          # --bg-2
C0 = (51, 201, 234)        # #33c9ea  (bright end)
C1 = (20, 104, 178)        # #1468b2  (deep end)
SS = 16                    # supersample factor
SIZES = {"favicon-32.png": 32, "favicon-192.png": 192, "apple-touch-icon.png": 180}


def render(size: int) -> Image.Image:
    s = size * SS
    k = s / 32.0            # same framing as the SVG viewBox
    img = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    d.rounded_rectangle([0, 0, s - 1, s - 1], radius=round(7 * k), fill=BG + (255,))

    width = max(1, round(2.4 * k * 0.96))
    pts = [((x + 4.5) * k, (y + 4) * k) for x, y in POINTS]
    n = len(pts) - 1
    for i in range(n):
        t = i / max(1, n - 1)
        col = tuple(round(a + (b - a) * t) for a, b in zip(C0, C1))
        d.line([pts[i], pts[i + 1]], fill=col + (255,), width=width)
    r = width / 2
    for j, (x, y) in enumerate(pts):
        t = j / max(1, n)
        col = tuple(round(a + (b - a) * t) for a, b in zip(C0, C1))
        d.ellipse([x - r, y - r, x + r, y + r], fill=col + (255,))

    return img.resize((size, size), Image.LANCZOS)


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    for name, size in SIZES.items():
        render(size).save(OUT / name)
        print(f"wrote assets/img/{name} ({size}x{size})")


if __name__ == "__main__":
    main()
