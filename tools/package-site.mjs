#!/usr/bin/env node
/**
 * Package the deployable site.
 *
 * The repository holds more than the site: the renderer, the authored content,
 * the page templates and the tooling. A direct upload to Cloudflare Pages
 * publishes *everything* it is handed, so uploading the repository root ships
 * `tools/` and its 1.5 MB of source fonts to the public web, and — worse —
 * invites the mistake of forgetting `admin/` and losing the editor.
 *
 * So this stages exactly the deployable subset into `dist/` and zips it:
 *
 *     node tools/package-site.mjs             # render, stage, zip
 *     node tools/package-site.mjs --no-build  # stage whatever is on disk
 *     node tools/package-site.mjs --no-zip    # render and stage only (a host's build step)
 *     node tools/package-site.mjs --out site.zip
 *
 * The zip holds the site at its root (index.html at the top level), which is
 * what Pages' direct upload expects. It refuses to emit a broken bundle: every
 * local href/src/url() in the staged pages and stylesheets is resolved against
 * the staged tree first, and a path that would not exist on the host is a hard
 * error rather than a 404 discovered by a reader.
 *
 * No dependencies. The zip is written directly.
 */

import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateRawSync } from "node:zlib";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DIST = join(ROOT, "dist");

/** What actually goes on the host. Everything else is working material. */
const PAGES = ["index.html", "data.html", "setup.html", "training.html", "reference.html"];
const ROOT_FILES = ["robots.txt", "sitemap.xml", "_headers"];
const TREES = ["assets"];
const ADMIN = ["admin/index.html", "admin/config.yml"];

/**
 * Paths that must never appear in a bundle. The editor files live under
 * `admin/`, so a bare `admin` is not on the list — but `admin/SETUP.md` is
 * handled by the allowlist above, which only ever copies the two named files.
 */
const FORBIDDEN = ["/src/", "/content/", "/tools/", "/.github/", "/.freebuff/", "/dist/", "/node_modules/"];
const FORBIDDEN_FILES = new Set(["readme.md", "admin/setup.md", "package.json", "package-lock.json"]);

// ---------------------------------------------------------------- staging ---

function walk(dir, rel = "") {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const abs = join(dir, entry.name);
    const name = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...walk(abs, name));
    else if (entry.isFile()) out.push({ name, abs });
  }
  return out;
}

function stage() {
  rmSync(DIST, { recursive: true, force: true });
  mkdirSync(DIST, { recursive: true });

  const wanted = [];
  for (const f of [...PAGES, ...ROOT_FILES, ...ADMIN]) wanted.push({ name: f, abs: join(ROOT, f) });
  for (const tree of TREES) {
    const abs = join(ROOT, tree);
    if (!existsSync(abs)) fail(`the ${tree}/ directory is missing — nothing to stage`);
    wanted.push(...walk(abs, tree));
  }

  const missing = wanted.filter((f) => !existsSync(f.abs));
  if (missing.length) fail(`missing from the repository: ${missing.map((f) => f.name).join(", ")}`);

  for (const f of wanted) {
    const dest = join(DIST, f.name);
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(f.abs, dest);
  }

  // Belt and braces: the allowlist above is the real guard, so anything found
  // here means a tree was added to TREES carelessly.
  for (const f of walk(DIST)) {
    const lower = f.name.toLowerCase();
    const suspect = FORBIDDEN.some((p) => `/${lower}`.includes(p)) || FORBIDDEN_FILES.has(lower);
    if (suspect) fail(`refusing to publish ${f.name} — it is working material, not site content`);
  }

  return walk(DIST);
}

// ------------------------------------------------------------- link check ---

/** Strip a query and fragment, and ignore anything that is not a local path. */
function localPath(url) {
  if (!url) return null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(url) || url.startsWith("//") || url.startsWith("#")) return null;
  return url.split(/[?#]/)[0];
}

function resolves(fromFile, url) {
  const clean = localPath(url);
  if (clean === null) return true;
  // Put percent-encoding back before touching the filesystem: the fonts and
  // filenames here are ASCII, but URLs are not guaranteed to be.
  let target;
  try {
    target = decodeURIComponent(clean);
  } catch {
    return false;
  }
  const abs = target.startsWith("/")
    ? join(DIST, target)
    : resolve(dirname(join(DIST, fromFile)), target);
  if (!abs.startsWith(DIST)) return false;
  if (existsSync(abs) && statSync(abs).isFile()) return true;
  if (existsSync(abs) && statSync(abs).isDirectory() && existsSync(join(abs, "index.html"))) return true;
  if (existsSync(join(DIST, target.replace(/\/$/, ""), "index.html"))) return true;
  return false;
}

function checkLinks(files) {
  const problems = [];
  for (const f of files) {
    const body = f.name === "assets/js/search-index.js" ? null : readFileSync(f.abs, "utf8");
    if (body === null) continue;
    const ext = extname(f.name).toLowerCase();
    const refs = [];
    if (ext === ".html") {
      for (const m of body.matchAll(/\b(?:href|src)="([^"]*)"/g)) refs.push(m[1]);
    } else if (ext === ".css") {
      for (const m of body.matchAll(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g)) refs.push(m[2]);
    } else {
      continue;
    }
    for (const ref of refs) {
      if (!resolves(f.name, ref)) problems.push(`${f.name} → ${ref}`);
    }
  }
  return problems;
}

// --------------------------------------------------------------------- zip ---

const CRC = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i += 1) c = CRC[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function dosStamp(date) {
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1),
    date: ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

function zip(entries) {
  const stamp = dosStamp(new Date());
  const parts = [];
  const central = [];
  let offset = 0;

  for (const entry of entries) {
    const raw = readFileSync(entry.abs);
    const name = Buffer.from(entry.name, "utf8");
    const crc = crc32(raw);
    const deflated = deflateRawSync(raw, { level: 9 });
    const stored = deflated.length >= raw.length;
    const body = stored ? raw : deflated;
    const method = stored ? 0 : 8;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(stamp.time, 10);
    local.writeUInt16LE(stamp.date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);

    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0);
    dir.writeUInt16LE(20, 4); // version made by
    dir.writeUInt16LE(20, 6); // version needed
    dir.writeUInt16LE(0x0800, 8);
    dir.writeUInt16LE(method, 10);
    dir.writeUInt16LE(stamp.time, 12);
    dir.writeUInt16LE(stamp.date, 14);
    dir.writeUInt32LE(crc, 16);
    dir.writeUInt32LE(body.length, 20);
    dir.writeUInt32LE(raw.length, 24);
    dir.writeUInt16LE(name.length, 28);
    // Regular file (0o100644), not a directory. Multiplied rather than shifted:
    // `<<` is a 32-bit signed op, and this value has the high bit set.
    dir.writeUInt32LE(0o100644 * 0x10000, 38);
    dir.writeUInt32LE(offset, 42);

    parts.push(local, name, body);
    central.push(dir, name);
    offset += 30 + name.length + body.length;
  }

  const cd = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);

  return Buffer.concat([...parts, cd, eocd]);
}

// -------------------------------------------------------------------- main ---

function fail(message) {
  console.error(`\n  ✗ ${message}\n`);
  process.exit(1);
}

const argv = process.argv.slice(2);
const skipBuild = argv.includes("--no-build");
const skipZip = argv.includes("--no-zip");
const outIndex = argv.indexOf("--out");
const OUT = outIndex === -1 ? join(ROOT, "training-guide.zip") : resolve(ROOT, argv[outIndex + 1] ?? "");
if (outIndex !== -1 && !argv[outIndex + 1]) fail("--out needs a path");

if (!skipBuild) {
  console.log("  rendering the pages…");
  const build = spawnSync(process.execPath, [join(ROOT, "tools", "build.mjs")], {
    cwd: ROOT,
    stdio: "inherit",
  });
  if (build.status !== 0) fail("the render failed — the bundle was not written");
}

const files = stage();

const broken = checkLinks(files);
if (broken.length) {
  fail(`these references would 404 on the host:\n      ${broken.join("\n      ")}`);
}

const bytes = files.reduce((sum, f) => sum + statSync(f.abs).size, 0);
const kb = (n) => `${(n / 1024).toFixed(n < 1024 * 100 ? 1 : 0)} KB`;

if (skipZip) {
  console.log(`\n  Staged ${files.length} files into dist/ (${kb(bytes)}) — no zip, as asked\n`);
} else {
  const zipped = zip(files);
  writeFileSync(OUT, zipped);
  const rel = relative(ROOT, OUT).replace(/\\/g, "/");
  console.log(
    `\n  Bundled ${files.length} files (${kb(bytes)} raw, ${kb(zipped.length)} zipped)\n\n` +
      `  dist/                      the same tree, unzipped — for wrangler or a drag-and-drop\n` +
      `  ${rel}${' '.repeat(Math.max(1, 22 - rel.length))}the upload bundle, site at its root\n`,
  );
}

console.log(
  files
    .filter((f) => !f.name.includes("/"))
    .map((f) => `    ${f.name}`)
    .join("\n"),
);
console.log(`
  Editor included: ${files.some((f) => f.name === "admin/index.html") ? "yes" : "NO — check the allowlist"}
`);
