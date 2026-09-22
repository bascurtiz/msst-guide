/**
 * Serve the guide at msst-guide.pages.dev, relayed from the InStatic install.
 *
 * The content moved into InStatic, which is a server, so this Pages project is
 * no longer the site — it is the public front door for it. Cloudflare will not
 * proxy an external origin from `_redirects` ("Proxying will only support
 * relative URLs on your site"), so the relay is done here, in a Pages Function
 * in advanced mode. Cloudflare's Direct Upload documentation confirms that a
 * `_worker.js` in the output directory is deployed by `wrangler pages deploy`,
 * which is how this site publishes.
 *
 * Two things it deliberately does *not* do:
 *
 *   - It never answers a page from this project's static assets. Those are the
 *     old, hand-authored pages; InStatic publishes its own copy and its own
 *     hashed assets under `/_instatic/`, so a request for `/assets/…` is relayed
 *     too. Falling back to `env.ASSETS` would quietly resurrect stale pages.
 *     The two host-level files below are the exception, and they are answered
 *     here because the container does not have them at all.
 *
 *   - It does not relay `/admin`. The editor's session cookie and its CSRF
 *     origin check are both bound to the container's hostname, so that path is
 *     redirected there instead of being dressed up under this one. The container
 *     keeps `PUBLIC_ORIGIN` as it is; nothing about the editor changes.
 *
 * The upstream host can be changed with a Pages environment variable,
 * `INSTATIC_ORIGIN`, without editing this file.
 */

const DEFAULT_ORIGIN = "https://msst-guide.up.railway.app";

/**
 * The pages the guide publishes. Old inbound links — and whatever Google has
 * already indexed — use `data.html`; InStatic publishes routes, so those are
 * sent to the route rather than left to 404. Anything else ending in `.html` is
 * left alone, because the container may legitimately serve HTML assets.
 */
const PAGE_ROUTES = new Set(["index", "data", "setup", "training", "reference"]);

/** The only thing worth caching: upstream ships these hashed and immutable. */
const IMMUTABLE = /^\/_instatic\//;

/**
 * Files that belong to the address the reader is on rather than to the content,
 * and which the container answers with a 404. They are served from this project's
 * own deployment — `tools/seo.py` writes them, and both name `msst-guide.pages.dev`.
 */
const HOST_FILES = new Set(["/robots.txt", "/sitemap.xml"]);

/** Framing headers that describe the relayed connection, not this response. */
const HOP_BY_HOP = [
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
];

/** `/data.html` → `/data`; `/index.html` → `/`; everything else → null. */
function legacyRoute(pathname) {
  if (!pathname.endsWith(".html")) return null;
  const name = pathname.slice(1, -5);
  if (!PAGE_ROUTES.has(name)) return null;
  return name === "index" ? "/" : `/${name}`;
}

/**
 * Forward the client's headers, minus the ones that belong to this hop. `cf-*`
 * is dropped because it describes the request as Cloudflare saw it, which is
 * not something the container should have to reason about.
 */
function relayHeaders(headers) {
  const out = new Headers(headers);
  out.delete("host");
  for (const name of [...out.keys()]) {
    if (name.startsWith("cf-")) out.delete(name);
  }
  return out;
}

export default {
  async fetch(request, env, ctx) {
    const origin = String(env.INSTATIC_ORIGIN || DEFAULT_ORIGIN).replace(/\/+$/, "");
    const url = new URL(request.url);

    if (url.pathname === "/admin" || url.pathname.startsWith("/admin/")) {
      return Response.redirect(`${origin}${url.pathname}${url.search}`, 302);
    }

    const legacy = legacyRoute(url.pathname);
    if (legacy !== null) {
      // Deliberately to our own host, not the container's: the point is to keep
      // the reader on the address they typed.
      return Response.redirect(new URL(`${legacy}${url.search}`, request.url), 301);
    }

    if (HOST_FILES.has(url.pathname)) {
      // Only GET and HEAD can reach here in practice; anything else is relayed,
      // because this file has no idea what a POST to a text file would mean.
      if (request.method === "GET" || request.method === "HEAD") return env.ASSETS.fetch(request);
    }

    const cacheable = request.method === "GET" && IMMUTABLE.test(url.pathname);
    const cache = caches.default;
    if (cacheable) {
      const hit = await cache.match(request);
      if (hit) {
        const served = new Response(hit.body, hit);
        served.headers.set("x-msst-proxy", "hit");
        return served;
      }
    }

    let upstream;
    try {
      upstream = await fetch(new URL(`${url.pathname}${url.search}`, origin), {
        method: request.method,
        headers: relayHeaders(request.headers),
        // A body is only allowed on the methods that have one; `HEAD` must not
        // carry one, and neither may `GET`.
        body: request.method === "GET" || request.method === "HEAD" ? undefined : request.body,
        // Follow nothing here: a redirect the container issues (a trailing slash,
        // say) has to reach the browser so the address bar stays on our host. It
        // is rewritten below.
        redirect: "manual",
      });
    } catch (error) {
      return new Response(
        `The guide's server did not answer (${error && error.message ? error.message : "unknown error"}).\n` +
          `It is the editor for this site, so the site is unavailable while it is down.\n`,
        { status: 502, headers: { "content-type": "text/plain; charset=utf-8" } },
      );
    }

    // A 204, 205 or 304 must not be given a body — `new Response(body, {status})`
    // throws for those, which would turn the container's conditional response
    // into our 500.
    const bodyless = upstream.status === 204 || upstream.status === 205 || upstream.status === 304;
    const response = new Response(bodyless ? null : upstream.body, upstream);

    for (const header of HOP_BY_HOP) response.headers.delete(header);
    // The runtime hands back a decoded body but the container's `content-encoding`
    // survives the hop, and a browser that trusts it would try to decode plain
    // bytes. `content-length` describes the compressed body, so it goes too.
    response.headers.delete("content-encoding");
    response.headers.delete("content-length");
    // HSTS is a promise about *this* hostname; it is not the container's to make.
    response.headers.delete("strict-transport-security");
    // A session cookie is bound to the container's hostname. Public pages set
    // none, and none may be handed out under this one.
    response.headers.delete("set-cookie");

    const location = response.headers.get("location");
    if (location && location.startsWith(origin)) {
      response.headers.set("location", `https://${url.host}${location.slice(origin.length)}`);
    }

    response.headers.set("x-msst-proxy", "miss");

    if (cacheable && upstream.status === 200) {
      ctx.waitUntil(cache.put(request, response.clone()));
    }

    return response;
  },
};
