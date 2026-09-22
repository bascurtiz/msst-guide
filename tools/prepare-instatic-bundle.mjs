#!/usr/bin/env node
/**
 * Stage a copy of `dist/` that InStatic's Site Import can read.
 *
 * Our build stamps every asset reference with a content hash —
 * `assets/css/site.css?v=61c969be` — which our own reference checker strips
 * (`tools/lib/refs.mjs`, `localTarget`) but which InStatic does not: it resolves
 * each `<link href>` against the dropped file paths, so the query string makes
 * the stylesheet look unlinked. The import then reports
 * "Stylesheet isn't linked by any imported page" and the site arrives unstyled.
 *
 * So this script copies the pages and rewrites `?v=<hash>` off every `href`/`src`
 * attribute. Nothing else changes: same bytes otherwise, same asset paths. The
 * live site is untouched — `dist/` stays stamped, and this writes a separate
 * directory you can delete.
 *
 *   node tools/package-site.mjs --no-zip     # render + stage into dist/
 *   node tools/prepare-instatic-bundle.mjs   # then make the importable copy
 *
 * Options:
 *   --from <dir>   source (default: dist)
 *   --out  <dir>   destination (default: dist-instatic)
 *   --keep-meta    also copy _headers, robots.txt and sitemap.xml
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Dropped on purpose. `admin/` is the CMS editor — importing it would create an
 * "admin" page on the new site. The other three are host-level files InStatic
 * owns itself (its publisher writes its own robots/sitemap, and `_headers` is a
 * Cloudflare Pages directive with no equivalent there).
 */
const SKIP = ["admin"];
const SKIP_META = ["_headers", "robots.txt", "sitemap.xml"];

/** `href="assets/css/site.css?v=61c969be"` → `href="assets/css/site.css"` */
const STAMPED = /((?:href|src)="[^"]+?)\?v=[A-Za-z0-9._-]+"/g;

const argv = process.argv.slice(2);
const opt = (name, fallback) => {
  const at = argv.indexOf(name);
  return at === -1 ? fallback : (argv[at + 1] ?? fallback);
};

const FROM = resolve(ROOT, opt("--from", "dist"));
const TO = resolve(ROOT, opt("--out", "dist-instatic"));
const keepMeta = argv.includes("--keep-meta");
const skipped = [...SKIP, ...(keepMeta ? [] : SKIP_META)];

if (!existsSync(FROM)) {
  console.error(`Nothing to stage: ${relative(ROOT, FROM)} does not exist.`);
  console.error("Run `node tools/package-site.mjs --no-zip` first.");
  process.exit(1);
}

function* walk(dir, base = "") {
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const rel = base ? `${base}/${entry.name}` : entry.name;
    if (skipped.includes(rel.split("/")[0]) || skipped.includes(rel)) continue;
    if (entry.isDirectory()) yield* walk(join(dir, entry.name), rel);
    else yield rel;
  }
}

rmSync(TO, { recursive: true, force: true });

let pages = 0;
let stamps = 0;
let copied = 0;

for (const rel of walk(FROM)) {
  const source = readFileSync(join(FROM, rel));
  const target = join(TO, rel);
  mkdirSync(dirname(target), { recursive: true });

  if (extname(rel) === ".html") {
    const before = source.toString("utf8");
    const after = before.replace(STAMPED, (_m, prefix) => {
      stamps += 1;
      return `${prefix}"`;
    });
    if (after !== before) pages += 1;
    writeFileSync(target, after);
  } else {
    writeFileSync(target, source);
  }
  copied += 1;
}

console.log(`  staged ${copied} file(s) into ${relative(ROOT, TO)}/`);
console.log(`  stripped ${stamps} ?v= stamp(s) across ${pages} page(s)`);
console.log(`  skipped: ${skipped.join(", ")}${keepMeta ? "" : " (host-level files InStatic publishes itself; --keep-meta copies them)"}`);
console.log("  now drop the *contents* of that folder into Site Import");
