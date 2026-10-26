/**
 * The two-host comparison behind `tools/compare-hosts.mjs`.
 *
 * Two stubbed CMSes on loopback, one of them broken in exactly one way per case —
 * the same shape as the relay's and the live check's tests, and for the same
 * reason: the failures this tool exists to catch are the ones that look like a
 * working site, so each one is worth a case that proves it is reported.
 *
 * Two of these cases are deliberately *not* failures. A renamed `/_instatic/`
 * bundle is what a content-hashed asset does after a publish, and a slightly
 * different text length can be whitespace — if either of those failed the tool,
 * it would cry wolf on a good import, and a check that cries wolf gets ignored.
 */

import assert from "node:assert/strict";
import http from "node:http";
import { execFile } from "node:child_process";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const runFile = promisify(execFile);

const TOOL = resolve(dirname(fileURLToPath(import.meta.url)), "..", "compare-hosts.mjs");
const GUIDE = "https://msst-guide.pages.dev/";
const ROUTES = ["/", "/data", "/setup", "/training", "/reference"];

/** A page that looks like the published guide, with knobs for one thing wrong. */
function page({
  heading = "Training Audio Source Separation Models",
  title = "Training Audio Source Separation Models — MSST Guide",
  canonical = GUIDE,
  withCanonical = true,
  text = "words about training runs and losses ".repeat(40),
  ogImage = `${GUIDE}uploads/some-id-og-image.png`,
  assets = [],
} = {}) {
  return [
    "<!doctype html><html><head>",
    `<title>${title}</title>`,
    withCanonical ? `<link rel="canonical" href="${canonical}">` : "",
    `<meta property="og:url" content="${canonical}">`,
    `<meta property="og:image" content="${ogImage}">`,
    "</head><body>",
    `<h1>${heading}</h1>`,
    `<p>${text}</p>`,
    ...assets.map((href) => `<img src="${href}">`),
    "</body></html>",
  ].join("\n");
}

/** A stubbed CMS: whatever it is told to serve, and a 404 for everything else. */
async function host({ pages, assets = {} }) {
  const server = http.createServer((request, response) => {
    const path = request.url.split("?")[0];
    const body = pages[path];
    if (body !== undefined) {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(body);
      return;
    }
    if (assets[path] !== undefined) {
      response.writeHead(200, { "content-type": "text/css" });
      response.end(assets[path]);
      return;
    }
    response.writeHead(404, { "content-type": "text/plain" });
    response.end("not found");
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  return {
    origin: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((done) => server.close(done)),
  };
}

/**
 * Run the tool once. This has to be async: the stubs are servers inside *this*
 * process, so a blocking spawn would starve them and every request would time out
 * — which is exactly what it looked like the first time.
 */
async function run(args) {
  try {
    const { stdout, stderr } = await runFile(process.execPath, [TOOL, ...args], { cwd: process.cwd() });
    return { status: 0, output: `${stdout}${stderr}` };
  } catch (error) {
    return { status: error.code ?? 1, output: `${error.stdout ?? ""}${error.stderr ?? ""}` };
  }
}

/**
 * Both hosts serving the guide, with `breakNew` applied to the new one only.
 * `breakNew` gets the base pages and may mutate them — the old host has already
 * been built from a copy by then, so a page deleted here is deleted on one side.
 */
async function pair(t, { breakNew = () => ({}), oldPages = {}, oldAssets = {}, newAssets = {} } = {}) {
  const styles = { "/_instatic/guide.css": "body{color:#111}" };
  const pages = Object.fromEntries(ROUTES.map((path) => [path, page()]));
  const before = await host({ pages: { ...pages, ...oldPages }, assets: { ...styles, ...oldAssets } });
  const tweaks = breakNew(pages);
  const after = await host({ pages: { ...pages, ...tweaks.pages }, assets: { ...styles, ...newAssets } });
  t.after(async () => {
    await before.close();
    await after.close();
  });
  return { before, after };
}

test("two hosts serving the same guide differ in nothing", async (t) => {
  const { before, after } = await pair(t);
  const result = await run(["--from", before.origin, "--to", after.origin]);

  assert.equal(result.status, 0, result.output);
  assert.match(result.output, /5 route\(s\)/);
  assert.match(result.output, /serves what the old one does/);
});

test("a page that never made it across is caught", async (t) => {
  const { before, after } = await pair(t, {
    breakNew: (pages) => {
      delete pages["/setup"];
      return { pages };
    },
  });
  const result = await run(["--from", before.origin, "--to", after.origin]);

  assert.equal(result.status, 1, result.output);
  assert.match(result.output, /\/setup answered 404 on the new host/);
});

test("a page that is the wrong page is caught", async (t) => {
  const { before, after } = await pair(t, {
    breakNew: () => ({ pages: { "/data": page({ heading: "Setup & configuration" }) } }),
  });
  const result = await run(["--from", before.origin, "--to", after.origin]);

  assert.equal(result.status, 1, result.output);
  assert.match(result.output, /a different page/);
  assert.match(result.output, /old  Training Audio Source Separation Models/);
  assert.match(result.output, /new  Setup & configuration/);
});

test("a canonical that moved to the new host is caught, with what to do about it", async (t) => {
  const { before, after } = await pair(t, {
    breakNew: () => ({ pages: { "/": page({ canonical: "https://new.example/" }) } }),
  });
  const result = await run(["--from", before.origin, "--to", after.origin]);

  assert.equal(result.status, 1, result.output);
  assert.match(result.output, /canonical changed/);
  assert.match(result.output, /re-entered after an import/);
});

test("a canonical that is simply absent means the plugin is not back yet", async (t) => {
  const { before, after } = await pair(t, {
    breakNew: (pages) => ({ pages: { ...pages, "/": page({ withCanonical: false }) } }),
  });
  const result = await run(["--from", before.origin, "--to", after.origin]);

  assert.equal(result.status, 1, result.output);
  assert.match(result.output, /not been reinstalled/);
});

test("an og:image that moved to another host is caught, whatever the picture is", async (t) => {
  const { before, after } = await pair(t, {
    // A different asset id would be fine — the library holds copies — but this one
    // points somewhere else entirely, which is the plugin's site address again.
    breakNew: (pages) => ({
      pages: { ...pages, "/": page({ ogImage: "https://new.example/uploads/other-id-og-image.png" }) },
    }),
  });
  const result = await run(["--from", before.origin, "--to", after.origin]);

  assert.equal(result.status, 1, result.output);
  assert.match(result.output, /og:image host changed/);
  assert.match(result.output, /new  https:\/\/new\.example/);
});

test("a different og:image asset on the same host is not a difference", async (t) => {
  const { before, after } = await pair(t, {
    breakNew: (pages) => ({ pages: { ...pages, "/": page({ ogImage: `${GUIDE}uploads/another-id-og-image.png` }) } }),
  });
  const result = await run(["--from", before.origin, "--to", after.origin]);

  assert.equal(result.status, 0, result.output);
});

test("a page that lost half its text is caught, because nothing else notices", async (t) => {
  const { before, after } = await pair(t, {
    breakNew: () => ({ pages: { "/training": page({ text: "words about training runs and losses ".repeat(12) }) } }),
  });
  const result = await run(["--from", before.origin, "--to", after.origin]);

  assert.equal(result.status, 1, result.output);
  assert.match(result.output, /lost content: 536 characters of text/);
  assert.match(result.output, /\d+% missing/);
});

test("a figure the new host does not serve is caught and proved missing", async (t) => {
  const figure = "/uploads/abc123-focus-before.png";
  // Only the old host's /data references the figure — and only the old host has it.
  const { before, after } = await pair(t, {
    oldPages: { "/data": page({ assets: [figure] }) },
    oldAssets: { [figure]: "png" },
  });

  const result = await run(["--from", before.origin, "--to", after.origin]);
  assert.equal(result.status, 1, result.output);
  assert.match(result.output, /no longer reference \/uploads\/abc123-focus-before\.png/);
  assert.match(result.output, /404s/);
});

test("an asset the new pages reference but the host does not serve is caught", async (t) => {
  const { before, after } = await pair(t, {
    breakNew: (pages) => ({ pages: { "/": page({ assets: ["/_instatic/missing.css"] }) } }),
  });
  const result = await run(["--from", before.origin, "--to", after.origin]);

  assert.equal(result.status, 1, result.output);
  assert.match(result.output, /references \/_instatic\/missing\.css, which answers 404/);
});

test("a renamed hashed bundle is a note, not a failure — that is what publishing does", async (t) => {
  const { before, after } = await pair(t, {
    newAssets: { "/_instatic/guide-2f9c.css": "body{color:#111}" },
    breakNew: () => ({ pages: { "/": page({ assets: ["/_instatic/guide-2f9c.css"] }) } }),
  });
  const result = await run(["--from", before.origin, "--to", after.origin]);

  assert.equal(result.status, 0, result.output);
  assert.match(result.output, /new name/);
  assert.match(result.output, /expected after an import/);
});

test("an origin may be given without its scheme, and https is what gets tried", { timeout: 60_000 }, async (t) => {
  const { before, after } = await pair(t);
  const noScheme = after.origin.replace("http://", "");
  // A TLS handshake against a plain-HTTP stub never completes, so each route waits
  // out the timeout: bound it rather than sitting through five of them.
  const result = await run(["--from", before.origin, "--to", noScheme, "--timeout", "2"]);

  // https:// is assumed, so a plain-HTTP stub cannot answer it — and the tool says
  // which URL it tried rather than quietly comparing nothing.
  assert.equal(result.status, 1, result.output);
  assert.ok(result.output.includes(`https://${noScheme}`), result.output);
});

test("--paths narrows the comparison to the routes named", async (t) => {
  const { before, after } = await pair(t);
  const result = await run(["--from", before.origin, "--to", after.origin, "--paths", "/,/data"]);

  assert.equal(result.status, 0, result.output);
  assert.match(result.output, /2 route\(s\)/);
});

test("it refuses to run without a host to compare against", async () => {
  const result = await run(["--from", "https://example.com"]);
  assert.equal(result.status, 1);
  assert.match(result.output, /--to is required/);

  const unknown = await run(["--nonsense"]);
  assert.equal(unknown.status, 1);
  assert.match(unknown.output, /unknown argument/);
});
