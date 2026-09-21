#!/usr/bin/env python3
"""
Render the social preview images for this site:

  assets/img/og-image.png      1200 x 630  (Open Graph, also used by LinkedIn/Discord)
  assets/img/twitter-card.png  1200 x 600  (X / Twitter summary_large_image)

Everything is drawn from the site's own palette and the header's waveform mark,
so the card cannot drift away from the design. Rerun after editing the title:

    python tools/make-og-image.py

Requires Pillow, and the Montserrat variable TTF in tools/fonts/
(see tools/fetch-fonts.py).
"""

import pathlib

from PIL import Image, ImageDraw, ImageFilter, ImageFont

ROOT = pathlib.Path(__file__).resolve().parent.parent
OUT = ROOT / "assets" / "img"
FONT = ROOT / "tools" / "fonts" / "Montserrat[wght].ttf"

SS = 2  # supersample factor: draw big, shrink at the end (crisp curves + type)

BG_TOP = (14, 16, 19)
BG_BOTTOM = (18, 23, 29)
CYAN = (2, 148, 190)
BLUE = (20, 104, 178)
TEXT = (232, 237, 243)
TEXT_2 = (167, 176, 186)
TEXT_3 = (124, 128, 133)
LINE = (42, 47, 55)
LINE_2 = (54, 59, 65)

EYEBROW = "Community handbook  ·  Music source separation"
TITLE_1 = "Training Audio Source"
TITLE_2 = "Separation Models"
SUB = ("Datasets, configuration, metrics and GPU time — the whole path from raw "
       "stems to a model you can separate audio with.")
CHIPS = ["13 chapters", "Local + cloud", "Metrics explained", "Error index"]
URL = "msst-guide.pages.dev"

_cache = {}


def font(size, weight=400):
    key = (size, weight)
    if key not in _cache:
        f = ImageFont.truetype(str(FONT), size)
        f.set_variation_by_axes([weight])
        _cache[key] = f
    return _cache[key]


def lerp(a, b, t):
    return tuple(round(a[i] + (b[i] - a[i]) * t) for i in range(3))


def gradient(size, start, end, horizontal=True):
    """Linear gradient image."""
    w, h = size
    img = Image.new("RGB", (1, h if not horizontal else w) and size)
    d = ImageDraw.Draw(img)
    if horizontal:
        for x in range(w):
            d.line([(x, 0), (x, h)], fill=lerp(start, end, x / max(1, w - 1)))
    else:
        for y in range(h):
            d.line([(0, y), (w, y)], fill=lerp(start, end, y / max(1, h - 1)))
    return img


def tracked(draw, xy, text, f, fill, tracking):
    """Draw letter-spaced text (PIL has no letter-spacing)."""
    x, y = xy
    for ch in text:
        draw.text((x, y), ch, font=f, fill=fill)
        x += draw.textlength(ch, font=f) + tracking
    return x


def tracked_width(draw, text, f, tracking):
    return sum(draw.textlength(c, font=f) for c in text) + tracking * max(0, len(text) - 1)


def wrap(draw, text, f, max_w):
    words, lines, line = text.split(), [], ""
    for w in words:
        trial = (line + " " + w).strip()
        if draw.textlength(trial, font=f) <= max_w or not line:
            line = trial
        else:
            lines.append(line)
            line = w
    if line:
        lines.append(line)
    return lines


def waveform_points(scale, ox, oy):
    """The header logo path (24x24 viewBox), parsed by hand:
    M2 14 h2.2 l1.6 -6 l1.8 10 l2 -14 l2 16 l1.8 -9 l1.6 4 H22"""
    raw = [2, 14, 4.2, 14, 5.8, 8, 7.6, 18, 9.6, 4, 11.6, 20, 13.4, 11, 15, 15, 22, 15]
    return [(ox + raw[i] * scale, oy + raw[i + 1] * scale) for i in range(0, len(raw), 2)]


def mask_gradient(size, shape_draw, start, end, horizontal=True):
    """Build a gradient and clip it to a black-on-white mask drawn by shape_draw."""
    mask = Image.new("L", size, 0)
    shape_draw(ImageDraw.Draw(mask))
    grad = gradient(size, start, end, horizontal)
    out = Image.new("RGB", size, (0, 0, 0))
    out.paste(grad, (0, 0), mask)
    return out, mask


def build(width, height):
    W, H = width * SS, height * SS
    img = Image.new("RGB", (W, H), BG_TOP)

    # --- background: vertical wash + a soft cyan glow behind the headline -----
    img.paste(gradient((W, H), BG_TOP, BG_BOTTOM, horizontal=False), (0, 0))
    glow = Image.new("L", (W, H), 0)
    gd = ImageDraw.Draw(glow)
    gd.ellipse([-W * 0.25, -H * 0.9, W * 0.72, H * 0.65], fill=90)
    gd.ellipse([W * 0.55, H * 0.35, W * 1.3, H * 1.5], fill=70)
    glow = glow.filter(ImageFilter.GaussianBlur(W * 0.06))
    tint = Image.new("RGB", (W, H), CYAN)
    img = Image.composite(Image.blend(img, tint, 0.22), img, glow)

    d = ImageDraw.Draw(img)
    inset = 72 * SS

    # --- vertical layout ------------------------------------------------------
    # The headline block is anchored to the top, the chips to the bottom edge,
    # and the supporting line is placed in whatever room is left above the
    # chips. Both card sizes (630 and 600 tall) therefore share one rhythm.
    mark_oy = 62 * SS
    mark_h = 92 * SS
    eyebrow_y = 176 * SS
    title_y = 212 * SS
    title_size = 68 * SS
    title_gap = 80 * SS
    chip_h = 46 * SS
    chip_y = H - inset - chip_h

    # --- the site's waveform mark, stroked with the brand gradient ------------
    scale = mark_h / 24
    pts = waveform_points(scale, inset, mark_oy)
    def stroke(target):
        target.line(pts, fill=255, width=int(4.4 * SS), joint="curve")
        for p in (pts[0], pts[-1]):
            r = 4.4 * SS / 2
            target.ellipse([p[0] - r, p[1] - r, p[0] + r, p[1] + r], fill=255)
    _, mark_mask = mask_gradient((W, H), stroke, CYAN, BLUE)
    img = Image.composite(gradient((W, H), CYAN, BLUE, horizontal=False), img, mark_mask)
    d = ImageDraw.Draw(img)

    # --- eyebrow --------------------------------------------------------------
    tracked(d, (inset, eyebrow_y), EYEBROW.upper(), font(21 * SS, 600), CYAN, 3.2 * SS)

    # --- headline: gradient-filled, two lines --------------------------------
    f1 = font(title_size, 800)
    _, t1_mask = mask_gradient((W, H), lambda t: t.text((inset, title_y), TITLE_1, font=f1, fill=255), CYAN, BLUE)
    _, t2_mask = mask_gradient((W, H), lambda t: t.text((inset, title_y + title_gap), TITLE_2, font=f1, fill=255), TEXT, TEXT)
    img = Image.composite(gradient((W, H), CYAN, BLUE, horizontal=False), img, t1_mask)
    img = Image.composite(Image.new("RGB", (W, H), TEXT), img, t2_mask)
    d = ImageDraw.Draw(img)

    # --- supporting line: fills the gap between headline and chips ------------
    f2 = font(26 * SS, 400)
    sub_lines = wrap(d, SUB, f2, W - inset * 2 - 150 * SS)
    sub_y = chip_y - 24 * SS - len(sub_lines) * 36 * SS
    for line in sub_lines:
        d.text((inset, sub_y), line, font=f2, fill=TEXT_2)
        sub_y += 36 * SS

    # --- chips (anchored to the bottom edge) ---------------------------------
    fc = font(20 * SS, 600)
    x = inset
    y = chip_y

    x = inset
    pad_x = 20 * SS
    for label in CHIPS:
        w = tracked_width(d, label, fc, 0.6 * SS)
        box = [x, y, x + w + pad_x * 2, y + chip_h]
        d.rounded_rectangle(box, radius=chip_h // 2, outline=LINE_2, width=max(1, SS))
        tracked(d, (x + pad_x, y + chip_h * 0.30), label, fc, TEXT_2, 0.6 * SS)
        x = box[2] + 12 * SS

    # --- bottom accent bar + domain ------------------------------------------
    f3 = font(20 * SS, 600)
    uw = d.textlength(URL, font=f3)
    d.text((W - inset - uw, y + chip_h * 0.32), URL, font=f3, fill=TEXT_3)
    img.paste(gradient((W, 5 * SS), CYAN, BLUE), (0, H - 5 * SS))

    return img.resize((width, height), Image.LANCZOS)


if __name__ == "__main__":
    OUT.mkdir(parents=True, exist_ok=True)
    for name, size in (("og-image.png", (1200, 630)), ("twitter-card.png", (1200, 600))):
        img = build(*size)
        img.save(OUT / name, optimize=True)
        print(f"  {name:<20} {size[0]}x{size[1]}  {(OUT / name).stat().st_size / 1024:5.1f} KB")
