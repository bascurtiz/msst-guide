import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { localRefs, localTarget, resolveInRoot } from "./refs.mjs";

test("only this site's own files count as local references", () => {
  const others = [
    "https://msst-guide.pages.dev/setup.html",
    "http://127.0.0.1:8137/",
    "//cdn.jsdelivr.net/font.woff2",
    "mailto:someone@example.com",
    "data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=",
    "#calc",
    "",
    undefined,
  ];
  for (const url of others) assert.equal(localTarget(url), null, url);
});

test("a query and a fragment are stripped, because neither names a file", () => {
  assert.equal(localTarget("assets/css/site.css?v=61c969be"), "assets/css/site.css");
  assert.equal(localTarget("data.html#dataset"), "data.html");
  assert.equal(localTarget("/assets/uploads/pic.png?v=2#top"), "/assets/uploads/pic.png");
});

test("percent-encoding is decoded before it reaches the filesystem", () => {
  assert.equal(localTarget("assets/img/my%20figure.png"), "assets/img/my figure.png");
  // a broken escape is not a filename, and must not throw
  assert.equal(localTarget("assets/img/100%25.png"), "assets/img/100%.png");
  assert.equal(localTarget("assets/img/%zz.png"), null);
});

test("references are collected once each, in document order", () => {
  const html = '<a href="data.html#a">x</a><img src="assets/img/a.png"><a href="data.html#b">y</a>'
    + '<a href="https://example.com">z</a><a href="#top">t</a>';
  assert.deepEqual(localRefs(html).map((ref) => ref.target), ["data.html", "assets/img/a.png"]);
  assert.equal(localRefs(html)[0].url, "data.html#a", "the raw reference is kept for the message");
});

test("resolution needs the file to exist, and refuses to climb out of the site", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "refs-test-"));
  fs.mkdirSync(path.join(root, "assets", "uploads"), { recursive: true });
  fs.writeFileSync(path.join(root, "assets", "uploads", "pic.png"), "x");
  fs.mkdirSync(path.join(root, "admin"), { recursive: true });
  fs.writeFileSync(path.join(root, "admin", "index.html"), "<!doctype html>");
  fs.writeFileSync(path.join(root, "index.html"), "<!doctype html>");

  try {
    assert.equal(resolveInRoot(root, "/assets/uploads/pic.png"), true, "root-absolute upload");
    assert.equal(resolveInRoot(root, "assets/uploads/pic.png"), true, "relative upload");
    assert.equal(resolveInRoot(root, "admin/"), true, "a directory with an index.html");
    assert.equal(resolveInRoot(root, "/"), true, "the site root");
    assert.equal(resolveInRoot(root, "index.html"), true);

    assert.equal(resolveInRoot(root, "assets/uploads/typo.png"), false, "missing file");
    assert.equal(resolveInRoot(root, "assets/uploads"), false, "a directory with no index.html");
    assert.equal(resolveInRoot(root, "../../etc/passwd"), false, "outside the site");
    assert.equal(resolveInRoot(root, "/../../etc/passwd"), false, "outside the site, absolute");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
