import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The relay that serves this Pages project's pages from the InStatic container.
 *
 * It is a Module Worker, so a `data:` URL is the cheapest way to import it as
 * ESM — the repository has no `package.json` to mark `.js` as a module, and the
 * file must stay a plain `.js` because that is what Pages deploys.
 *
 * Nothing here touches the network: the container is a stub, which is the point.
 * What these tests protect is the hygiene of the hop — a header that must not be
 * relayed, a redirect that must not leak the container's hostname, and a status
 * code that must not be turned into a 500.
 */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const source = fs.readFileSync(path.join(ROOT, "_worker.js"), "utf8");
const worker = (await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`)).default;

const ORIGIN = "https://msst-guide.up.railway.app";
const HOST = "https://msst-guide.pages.dev";

const html = (body = "<!doctype html><title>MSST Guide</title>") =>
  new Response(body, {
    status: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "content-encoding": "gzip",
      "strict-transport-security": "max-age=63072000; includeSubDomains",
      "set-cookie": "session=abc123; Path=/; HttpOnly",
    },
  });

/**
 * Stand in for the runtime: `fetch` records what the relay asked for and answers
 * from a table, `caches.default` is a Map with the two methods that matter.
 */
function runtime(respond) {
  const calls = [];
  const store = new Map();
  const real = { fetch: globalThis.fetch, caches: globalThis.caches };

  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init: init ?? {} });
    return respond(new URL(String(url)), init ?? {});
  };
  globalThis.caches = {
    default: {
      match: async (request) => store.get(String(request.url)),
      put: async (request, response) => void store.set(String(request.url), response),
    },
  };

  return {
    calls,
    store,
    get: (p, init, env = {}) =>
      worker.fetch(new Request(`${HOST}${p}`, init), env, { waitUntil: (promise) => promise }),
    restore() {
      globalThis.fetch = real.fetch;
      globalThis.caches = real.caches;
    },
  };
}

test("a page is relayed from the container, without the container's transport policy", async () => {
  const host = runtime(() => html());
  try {
    const response = await host.get("/setup");

    assert.equal(response.status, 200);
    assert.equal(host.calls[0].url, `${ORIGIN}/setup`, "the container is asked for the same path");
    assert.match(await response.text(), /MSST Guide/);

    // The body arrives decoded, so the container's `content-encoding` would make
    // a browser decode plain bytes a second time.
    assert.equal(response.headers.get("content-encoding"), null);
    assert.equal(response.headers.get("content-length"), null);
    // HSTS is a promise about a hostname, and a session cookie belongs to the
    // hostname that issued it.
    assert.equal(response.headers.get("strict-transport-security"), null);
    assert.equal(response.headers.get("set-cookie"), null);
    assert.equal(response.headers.get("content-type"), "text/html; charset=utf-8", "everything else survives");
    assert.equal(response.headers.get("x-msst-proxy"), "miss");
  } finally {
    host.restore();
  }
});

test("the old .html addresses are sent to the route, and stay on the reader's host", async () => {
  const host = runtime(() => html());
  try {
    for (const [from, to] of [["/data.html", "/data"], ["/index.html", "/"], ["/reference.html?q=1", "/reference?q=1"]]) {
      const response = await host.get(from);
      assert.equal(response.status, 301, from);
      assert.equal(response.headers.get("location"), `${HOST}${to}`, from);
    }
    assert.equal(host.calls.length, 0, "these never reach the container");

    // Only the published routes are rewritten; the container may serve its own
    // HTML assets, and guessing at those would send readers to a 404.
    const passthrough = await host.get("/_instatic/partial.html");
    assert.equal(passthrough.status, 200);
  } finally {
    host.restore();
  }
});

test("the files that belong to this address are answered here, not relayed", async () => {
  const host = runtime(() => html());
  try {
    const asked = [];
    const env = {
      ASSETS: {
        fetch: (request) => {
          asked.push(new URL(request.url).pathname);
          return new Response("User-agent: *", { headers: { "content-type": "text/plain" } });
        },
      },
    };

    const response = await host.get("/robots.txt", {}, env);
    assert.equal(response.status, 200);
    assert.deepEqual(asked, ["/robots.txt"], "served from this deployment");
    assert.equal(host.calls.length, 0, "the container is not asked for a file it does not have");

    await host.get("/sitemap.xml", {}, env);
    assert.deepEqual(asked, ["/robots.txt", "/sitemap.xml"]);

    // Everything else is still the container's, and a write is never answered
    // from a text file.
    await host.get("/setup");
    await host.get("/robots.txt", { method: "POST", body: "x" }, env);
    assert.deepEqual(
      host.calls.map((call) => call.url),
      [`${ORIGIN}/setup`, `${ORIGIN}/robots.txt`],
    );
  } finally {
    host.restore();
  }
});

test("the editor is sent to its own hostname, where its session and CSRF origin live", async () => {
  const host = runtime(() => html());
  try {
    const response = await host.get("/admin/config.yml");
    assert.equal(response.status, 302);
    assert.equal(response.headers.get("location"), `${ORIGIN}/admin/config.yml`);
    assert.equal(host.calls.length, 0);

    const bare = await host.get("/admin");
    assert.equal(bare.headers.get("location"), `${ORIGIN}/admin`);
  } finally {
    host.restore();
  }
});

test("hashed assets are cached at the edge, so a repeat reader never waits on the container", async () => {
  const host = runtime(() => new Response("body{}", { headers: { "cache-control": "public, max-age=31536000, immutable" } }));
  try {
    const first = await host.get("/_instatic/css/userStyles-6b13c7edb8a1.css");
    const second = await host.get("/_instatic/css/userStyles-6b13c7edb8a1.css");

    assert.equal(host.calls.length, 1, "the container is asked once");
    assert.equal(first.headers.get("x-msst-proxy"), "miss");
    assert.equal(second.headers.get("x-msst-proxy"), "hit");
    assert.equal(await second.text(), "body{}");

    // Pages are not cached: an edit must be visible as soon as it is published.
    await host.get("/setup");
    await host.get("/setup");
    assert.equal(host.calls.length, 3);
  } finally {
    host.restore();
  }
});

test("a redirect from the container keeps the address bar on this host", async () => {
  const host = runtime((url) =>
    url.pathname === "/setup"
      ? new Response(null, { status: 301, headers: { location: `${ORIGIN}/setup/` } })
      : html(),
  );
  try {
    const response = await host.get("/setup");
    assert.equal(response.status, 301);
    assert.equal(response.headers.get("location"), `${HOST}/setup/`);

    // A redirect that leaves the container is the container's business.
    assert.equal(host.calls[0].init.redirect, "manual", "a redirect is never followed here");
  } finally {
    host.restore();
  }
});

test("a bodyless status is passed through instead of becoming an error", async () => {
  const host = runtime(() => new Response(null, { status: 304, headers: { etag: '"abc"' } }));
  try {
    const response = await host.get("/setup");
    assert.equal(response.status, 304, "a 304 must not be given a body");
    assert.equal(response.headers.get("etag"), '"abc"');
  } finally {
    host.restore();
  }
});

test("when the container is down, the reader is told what that means", async () => {
  const host = runtime(() => {
    throw new Error("connection refused");
  });
  try {
    const response = await host.get("/setup");
    assert.equal(response.status, 502);
    assert.match(await response.text(), /did not answer/);
  } finally {
    host.restore();
  }
});
