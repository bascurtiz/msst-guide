#!/usr/bin/env node
/**
 * Stage — and optionally deploy — the Cloudflare Pages bundle for this project.
 *
 * This repository no longer renders the guide. The words and the layout live in
 * the CMS (see `admin/INSTATIC-HOSTING.md`), and what is deployed here is the
 * front door for that CMS: `_worker.js`, a Pages Function that relays every
 * reader request to it, plus the files that belong to the address rather than to
 * the content.
 *
 *     node tools/deploy-pages.mjs              # stage dist/, then deploy it
 *     node tools/deploy-pages.mjs --no-deploy  # stage only — inspect it, or let CI deploy
 *     node tools/deploy-pages.mjs --out <dir>  # stage somewhere else
 *     node tools/deploy-pages.mjs --root <dir> # read the files from somewhere else (the tests)
 *
 * It is an allowlist, not a copy of the tree, and that is the whole point: a
 * direct upload publishes everything it is handed, so the one file that must
 * never be in this bundle is a hand-built page. The old pages still exist in git
 * (`git checkout legacy-static-pipeline`), but a stray `index.html` here would
 * be a page that quietly stops being updated — readers get their pages from the
 * relay, so such a file could only ever be served by accident, and it would look
 * current while going stale.
 *
 * The checks below are the other half. They are cheap, they run before anything
 * is uploaded, and each one is a mistake that would otherwise be discovered by a
 * reader: the relay has no default origin to send a request to, `robots.txt`
 * points at a sitemap that is not there, the sitemap advertises a route the relay
 * does not handle (a 404 for a crawler), or `robots.txt` and `sitemap.xml` name
 * different hosts because a domain change was made in one of them.
 *
 * No dependencies: Node and `npx` are all this needs.
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
} from "node:fs";
import { dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** What goes on the host, and nothing else. */
const BUNDLE = ["_worker.js", "_headers", "robots.txt", "sitemap.xml"];

// ---------------------------------------------------------------- staging ---

function fail(message) {
  console.error(`\n  ✗ ${message}\n`);
  process.exit(1);
}

/** Every file under `dir`, as paths relative to it, sorted. */
function walk(dir, base = "") {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const rel = base ? `${base}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...walk(join(dir, entry.name), rel));
    else if (entry.isFile()) out.push(rel);
  }
  return out;
}

function stage(from, to) {
  const missing = BUNDLE.filter((name) => !existsSync(join(from, name)));
  if (missing.length) fail(`missing from the repository: ${missing.join(", ")}`);

  rmSync(to, { recursive: true, force: true });
  mkdirSync(to, { recursive: true });
  for (const name of BUNDLE) copyFileSync(join(from, name), join(to, name));

  // Belt and braces around the allowlist: a page in here means someone added one
  // to `BUNDLE`, or a copy dragged one along.
  const pages = walk(to).filter((name) => extname(name).toLowerCase() === ".html");
  if (pages.length) {
    fail(
      `refusing to bundle ${pages.join(", ")} — pages are published by the CMS now,\n` +
        `      and one here would be a stale page waiting to be served.`,
    );
  }

  return walk(to);
}

// ------------------------------------------------------------- the checks ---

/**
 * The page routes the relay knows, read out of `_worker.js` rather than
 * duplicated here: the sitemap check below is only worth anything if it is
 * comparing against the thing that actually answers requests.
 */
function pageRoutes(source) {
  const match = source.match(/const\s+PAGE_ROUTES\s*=\s*new Set\(\[([^\]]*)\]\)/);
  if (match === null) {
    fail("`_worker.js` no longer declares `PAGE_ROUTES` — its routes cannot be checked against the sitemap.");
  }
  return new Set(
    match[1]
      .split(",")
      .map((name) => name.trim().replace(/^["']|["']$/g, ""))
      .filter(Boolean),
  );
}

function check(from) {
  const worker = readFileSync(join(from, "_worker.js"), "utf8");
  if (!/\bexport\s+default\b/.test(worker)) {
    fail("`_worker.js` has no default export — Pages would deploy it as a plain file, not as a Function.");
  }
  if (!/\bDEFAULT_ORIGIN\b/.test(worker)) {
    fail("`_worker.js` names no default origin, so the relay would have nowhere to send a request.");
  }

  const robots = readFileSync(join(from, "robots.txt"), "utf8");
  const sitemapLine = robots.match(/^\s*Sitemap:\s*(\S+)\s*$/m);
  if (sitemapLine === null) {
    fail("`robots.txt` has no `Sitemap:` line, so crawlers would never find the sitemap.");
  }
  let declared;
  try {
    declared = new URL(sitemapLine[1]);
  } catch {
    fail(`\`robots.txt\` advertises an unparseable sitemap URL: ${sitemapLine[1]}`);
  }

  const sitemap = readFileSync(join(from, "sitemap.xml"), "utf8");
  if (!sitemap.includes("<urlset")) {
    fail("`sitemap.xml` has no `<urlset>` — it is not a sitemap.");
  }

  const locs = [...sitemap.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)].map((m) => m[1]);
  if (locs.length === 0) fail("`sitemap.xml` lists no URLs, so it tells a crawler nothing.");

  const known = pageRoutes(worker);
  const unknown = [];
  const offHost = [];
  for (const loc of locs) {
    let url;
    try {
      url = new URL(loc);
    } catch {
      fail(`\`sitemap.xml\` has an unparseable <loc>: ${loc}`);
    }
    if (url.origin !== declared.origin) offHost.push(loc);
    // `/` is the home page, which the relay answers from its root route; every
    // other path has to be one of the routes it dispatches.
    const page = url.pathname.replace(/^\/+|\/+$/g, "");
    if (page !== "" && !known.has(page) && !known.has(page.replace(/\.html$/, ""))) unknown.push(loc);
  }

  if (offHost.length) {
    fail(
      `\`robots.txt\` and \`sitemap.xml\` name different hosts:\n` +
        `      robots.txt  ${declared.origin}\n` +
        `      sitemap.xml ${offHost.join(", ")}\n` +
        `      A domain change made in one place only — \`tools/seo.py\` writes both.`,
    );
  }
  if (unknown.length) {
    fail(
      `\`sitemap.xml\` advertises routes the relay does not handle:\n      ${unknown.join("\n      ")}\n` +
        `      A crawler would index a 404. Known routes: ${[...known].join(", ")}`,
    );
  }

  return { locs: locs.length, origin: declared.origin };
}

// ------------------------------------------------------------------ deploy ---

function deploy(out) {
  const project = process.env.CLOUDFLARE_PROJECT_NAME || "msst-guide";
  if (!process.env.CLOUDFLARE_API_TOKEN || !process.env.CLOUDFLARE_ACCOUNT_ID) {
    fail(
      "no Cloudflare credentials.\n" +
        "      Set CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID, or stage only with --no-deploy.\n" +
        "      admin/INSTATIC-HOSTING.md has the token, its permission and where the ID comes from.",
    );
  }

  const run = spawnSync(
    "npx",
    [
      "--yes",
      "wrangler@4",
      "pages",
      "deploy",
      relative(ROOT, out) || ".",
      "--project-name",
      project,
      "--branch",
      "main",
    ],
    // `npx` is a `.cmd` shim on Windows and cannot be spawned directly there.
    { cwd: ROOT, stdio: "inherit", shell: process.platform === "win32" },
  );
  if (run.status !== 0) fail("the deploy failed — the deployment already live is untouched.");
}

// -------------------------------------------------------------------- main ---

const argv = process.argv.slice(2);
const outIndex = argv.indexOf("--out");
const rootIndex = argv.indexOf("--root");
if (outIndex !== -1 && !argv[outIndex + 1]) fail("--out needs a path");
if (rootIndex !== -1 && !argv[rootIndex + 1]) fail("--root needs a path");

const FROM = rootIndex === -1 ? ROOT : resolve(ROOT, argv[rootIndex + 1]);
const OUT = outIndex === -1 ? join(ROOT, "dist") : resolve(ROOT, argv[outIndex + 1]);

const files = stage(FROM, OUT);
const { locs, origin } = check(OUT);

const bytes = files.reduce((sum, name) => sum + statSync(join(OUT, name)).size, 0);
console.log(`\n  staged ${files.length} file(s) into ${relative(ROOT, OUT) || "."}/ (${(bytes / 1024).toFixed(1)} KB)`);
for (const name of files) console.log(`    ${name}`);
console.log(`  sitemap: ${locs} URL(s) on ${origin}, all of them routes the relay answers`);

if (argv.includes("--no-deploy")) {
  console.log("  not deployed (--no-deploy)\n");
} else {
  console.log("  deploying…");
  deploy(OUT);
}
