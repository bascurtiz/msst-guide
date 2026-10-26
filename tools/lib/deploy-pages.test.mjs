import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The stager behind `tools/deploy-pages.mjs`.
 *
 * It is deliberately narrow — four files and no pages — and every check it makes
 * is one that would otherwise be discovered by a crawler or a reader: a sitemap
 * advertising a route the relay does not answer, or `robots.txt` and
 * `sitemap.xml` naming different hosts after a domain change made in one of them.
 * Those are the failures worth a test, so they are what this exercises, against
 * the real `_worker.js` rather than a stub of it.
 */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const SCRIPT = path.join(ROOT, "tools", "deploy-pages.mjs");
const BUNDLE = ["_worker.js", "_headers", "robots.txt", "sitemap.xml"];

const workdirs = [];
function workdir() {
  const dir = mkdtempSync(path.join(tmpdir(), "msst-deploy-pages-"));
  workdirs.push(dir);
  return dir;
}
process.on("exit", () => {
  for (const dir of workdirs) rmSync(dir, { recursive: true, force: true });
});

/** A bundle source made of the repository's own files, so the checks meet reality. */
function bundleSource(overrides = {}) {
  const dir = workdir();
  for (const name of BUNDLE) copyFileSync(path.join(ROOT, name), path.join(dir, name));
  for (const [name, body] of Object.entries(overrides)) writeFileSync(path.join(dir, name), body);
  return dir;
}

function run(from) {
  const out = path.join(workdir(), "out");
  const result = spawnSync(process.execPath, [SCRIPT, "--no-deploy", "--root", from, "--out", out], {
    cwd: ROOT,
    encoding: "utf8",
  });
  return { ...result, out, output: `${result.stdout}${result.stderr}` };
}

test("stages the four bundle files and nothing else", () => {
  const result = run(bundleSource());
  assert.equal(result.status, 0, result.output);
  assert.deepEqual(readdirSync(result.out).sort(), [...BUNDLE].sort());
  assert.match(result.output, /staged 4 file\(s\)/);
  // The stager never deploys what it was asked only to stage.
  assert.doesNotMatch(result.output, /deploying/);
});

test("refuses a deployment with no default export", () => {
  const worker = readFileSync(path.join(ROOT, "_worker.js"), "utf8").replace(/\bexport default\b/, "const worker =");
  const result = run(bundleSource({ "_worker.js": worker }));
  assert.equal(result.status, 1);
  assert.match(result.output, /no default export/);
});

test("refuses a sitemap route the relay does not answer", () => {
  const sitemap = readFileSync(path.join(ROOT, "sitemap.xml"), "utf8").replace(
    "</urlset>",
    "  <url>\n    <loc>https://msst-guide.pages.dev/nope</loc>\n  </url>\n</urlset>",
  );
  const result = run(bundleSource({ "sitemap.xml": sitemap }));
  assert.equal(result.status, 1);
  assert.match(result.output, /routes the relay does not handle/);
  assert.match(result.output, /https:\/\/msst-guide\.pages\.dev\/nope/);
});

test("refuses robots.txt naming a host the sitemap does not", () => {
  const robots = readFileSync(path.join(ROOT, "robots.txt"), "utf8").replace(
    /^Sitemap:.*$/m,
    "Sitemap: https://example.invalid/sitemap.xml",
  );
  const result = run(bundleSource({ "robots.txt": robots }));
  assert.equal(result.status, 1);
  assert.match(result.output, /name different hosts/);
});

test("refuses a bundle with a required file missing", () => {
  const dir = workdir();
  for (const name of BUNDLE.filter((entry) => entry !== "_headers")) {
    copyFileSync(path.join(ROOT, name), path.join(dir, name));
  }
  const result = run(dir);
  assert.equal(result.status, 1);
  assert.match(result.output, /missing from the repository: _headers/);
});
