import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

/**
 * The checker that gates a deploy.
 *
 * It is tested against a stub rather than the live guide — a test that needs the
 * internet tells you about the internet. The stub is a site that *is* the guide,
 * and each case breaks exactly one thing about it, because the value of this tool
 * is not that it passes, it is that it fails when the site is wrong while up.
 *
 * The stub's pages mirror the checker's own expectations on purpose: change them
 * in one place and this fails, which is the reminder to change the other.
 */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const SCRIPT = path.join(ROOT, "tools", "check-live.mjs");
const run = promisify(execFile);

const PAGES = {
  "/": "Training Audio Source Separation Models",
  "/data": "Before you train",
  "/setup": "Setup &amp; configuration",
  "/training": "Training runs",
  "/reference": "Reference",
};
const ASSET = "/_instatic/css/userStyles-0000.css";

/**
 * A stand-in for the live site. `breaks` names the one thing wrong with it:
 * `asset` (the CMS is not serving its files), `relay` (Pages answered with a
 * static page instead of the relay), `heading` (a page is not the one we expect)
 * or `sitemap` (a route the relay does not answer is advertised).
 */
async function site(breaks = {}) {
  const server = createServer((request, response) => {
    const pathname = new URL(request.url, "http://127.0.0.1").pathname;
    const host = `http://127.0.0.1:${server.address().port}`;
    const headers = breaks.relay ? {} : { "x-msst-proxy": "miss" };

    const page = Object.prototype.hasOwnProperty.call(PAGES, pathname) ? pathname : null;
    if (page !== null) {
      const heading = breaks.heading === page ? "Something else entirely" : PAGES[page];
      const link = page === "/" ? `<link rel="stylesheet" href="${ASSET}">` : "";
      response.writeHead(200, { "content-type": "text/html; charset=utf-8", ...headers });
      response.end(`<!doctype html><title>Guide</title>${link}<h1>${heading}</h1>`);
      return;
    }
    if (pathname === ASSET) {
      response.writeHead(breaks.asset ? 404 : 200, { "content-type": "text/css" });
      response.end("/* the design system */");
      return;
    }
    const legacy = pathname.match(/^\/(index|data|setup|training|reference)\.html$/);
    if (legacy) {
      const to = legacy[1] === "index" ? "/" : `/${legacy[1]}`;
      response.writeHead(301, { location: `${host}${to}` });
      response.end();
      return;
    }
    if (pathname === "/admin/" || pathname === "/admin") {
      response.writeHead(302, { location: "http://cms.invalid/admin/" });
      response.end();
      return;
    }
    if (pathname === "/robots.txt") {
      response.writeHead(200, { "content-type": "text/plain" });
      response.end(`User-agent: *\nAllow: /\n\nSitemap: ${host}/sitemap.xml\n`);
      return;
    }
    if (pathname === "/sitemap.xml") {
      const paths = breaks.sitemap ? [...Object.keys(PAGES), "/gone"] : Object.keys(PAGES);
      response.writeHead(200, { "content-type": "application/xml" });
      response.end(
        `<urlset>${paths.map((p) => `<url><loc>${host}${p}</loc></url>`).join("")}</urlset>`,
      );
      return;
    }
    response.writeHead(404, { "content-type": "text/plain" });
    response.end("not here");
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

/** Run the checker once, without waiting for a deploy to propagate. */
async function checkLive(url) {
  try {
    const { stdout, stderr } = await run(process.execPath, [SCRIPT, "--base", url, "--wait", "0"], { cwd: ROOT });
    return { status: 0, output: `${stdout}${stderr}` };
  } catch (error) {
    return { status: error.code ?? 1, output: `${error.stdout ?? ""}${error.stderr ?? ""}` };
  }
}

async function withSite(breaks, assert_) {
  const stub = await site(breaks);
  try {
    await assert_(await checkLive(stub.url));
  } finally {
    await stub.close();
  }
}

test("passes against a site that is the guide", async () => {
  await withSite({}, (result) => {
    assert.equal(result.status, 0, result.output);
    assert.match(result.output, /is the guide, relayed from the CMS/);
  });
});

test("fails when a page is not the one we expect", async () => {
  await withSite({ heading: "/data" }, (result) => {
    assert.equal(result.status, 1, result.output);
    assert.match(result.output, /\/data — answered 200 with the wrong page/);
    assert.match(result.output, /expected heading {2}Before you train/);
    assert.match(result.output, /Something else entirely/);
  });
});

test("fails when Pages answered with a static page instead of the relay", async () => {
  await withSite({ relay: true }, (result) => {
    assert.equal(result.status, 1, result.output);
    assert.match(result.output, /no x-msst-proxy header/);
  });
});

test("fails when the CMS is not serving its assets", async () => {
  await withSite({ asset: true }, (result) => {
    assert.equal(result.status, 1, result.output);
    assert.match(result.output, /so the CMS is not serving its assets/);
  });
});

test("fails when the sitemap advertises a route the guide does not know", async () => {
  await withSite({ sitemap: true }, (result) => {
    assert.equal(result.status, 1, result.output);
    assert.match(result.output, /advertises routes this check does not know/);
    assert.match(result.output, /\/gone/);
  });
});
