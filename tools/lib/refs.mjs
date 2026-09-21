/**
 * Local file references in a rendered page.
 *
 * The repository root *is* the published site, so any `href` or `src` that
 * points at this site has to name a file that exists. This module is the pure
 * part of that check — which references are local, and where one resolves — kept
 * apart from the filesystem walking so it can be tested directly. The build
 * applies it to the pages it is about to write; the packager applies the same
 * idea to the staged bundle, from the file that contains the reference.
 *
 * The distinction that matters: a wrong path in the sidebar is markup, and
 * markup gets reviewed. A wrong path in *prose* is the author's, and he cannot
 * see it — he edits in a browser, so a mistyped filename, or an image uploaded
 * but never referenced, is a 404 nobody notices until a reader does.
 */

import fs from "node:fs";
import path from "node:path";

const REF = /\b(?:href|src)="([^"]*)"/g;

/**
 * The local path a reference points at, or null if it is not this site's
 * business: another origin, a protocol-relative URL, a bare fragment, a scheme
 * like `mailto:` or `data:`, or nothing at all.
 *
 * A query string and a fragment are stripped, because neither names a file —
 * `assets/css/site.css?v=61c969be` is the stylesheet, and `data.html#dataset` is
 * a page. A malformed percent-escape is not a filename either, so it is dropped
 * rather than thrown over.
 */
export function localTarget(url) {
  if (!url || url.startsWith("#") || url.startsWith("//")) return null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(url)) return null; // http:, mailto:, data:
  const clean = url.split(/[?#]/)[0];
  if (!clean) return null;
  try {
    return decodeURIComponent(clean);
  } catch {
    return null;
  }
}

/** Every local reference in a page, as `{ url, target }`, in document order. */
export function localRefs(html) {
  const out = [];
  for (const match of html.matchAll(REF)) {
    const target = localTarget(match[1]);
    if (target !== null && !out.some((ref) => ref.target === target)) {
      out.push({ url: match[1], target });
    }
  }
  return out;
}

/**
 * Does `target` name a file under `root` — or a directory that has an
 * `index.html`, which is how `href="admin/"` reaches the editor?
 *
 * `..` is refused rather than followed: a reference that climbs out of the site
 * is a mistake at best, and there is nothing outside to serve anyway.
 */
export function resolveInRoot(root, target) {
  const abs = path.resolve(root, target.replace(/^\//, ""));
  if (abs !== root && !abs.startsWith(root + path.sep)) return false;
  if (!fs.existsSync(abs)) return false;
  const stat = fs.statSync(abs);
  return stat.isFile() || (stat.isDirectory() && fs.existsSync(path.join(abs, "index.html")));
}
