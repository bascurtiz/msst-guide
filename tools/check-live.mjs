#!/usr/bin/env node
/**
 * Check the live guide — after a deploy, or whenever you want to know whether the
 * site a reader gets is the site we think we are serving.
 *
 *     node tools/check-live.mjs                    # https://msst-guide.pages.dev
 *     node tools/check-live.mjs --base <url>       # somewhere else (the tests use a stub)
 *     node tools/check-live.mjs --wait 0           # one pass, no waiting for a deploy to land
 *
 * A deploy that replaces the relay, or a CMS whose origin is down, both look like
 * success from the outside: Cloudflare will happily serve whatever it has. So
 * every check here is about a specific way the site can be *wrong while up*:
 *
 *   - **The five routes**, answered 200 with the page they should be. A page that
 *     changed its heading is caught by name rather than by a byte count.
 *   - **The relay answered, not an asset.** Every page response must carry the
 *     `x-msst-proxy` header `_worker.js` sets. A hand-built page sitting in the
 *     Pages bundle — the one mistake the stager refuses to make — would answer
 *     without it, and look completely normal.
 *   - **The CMS is actually reachable.** One asset the page references under
 *     `/_instatic/` is fetched, so a cached page in front of a dead container
 *     fails here instead of the first time a reader loads a picture.
 *   - **The old addresses still redirect**, and the editor path still points at
 *     the CMS rather than at us.
 *   - **`robots.txt` and `sitemap.xml`** are served, agree about the host, and
 *     advertise no route the relay does not answer.
 *
 * Runs on Node alone. Exits non-zero with a list of what is wrong, so a workflow
 * can use it as the last gate of a deploy.
 */

const DEFAULT_BASE = "https://msst-guide.pages.dev";
const TIMEOUT_MS = 20_000;
const RETRY_PAUSE_MS = 5_000;

/** The guide, as a reader meets it: route and the heading that has to be on it. */
const PAGES = [
  { path: "/", heading: "Training Audio Source Separation Models" },
  { path: "/data", heading: "Before you train" },
  { path: "/setup", heading: "Setup & configuration" },
  { path: "/training", heading: "Training runs" },
  { path: "/reference", heading: "Reference" },
];

/** Addresses that existed before the guide moved; a crawler may still ask for them. */
const LEGACY = [
  ["/data.html", "/data"],
  ["/setup.html", "/setup"],
  ["/training.html", "/training"],
  ["/reference.html", "/reference"],
  ["/index.html", "/"],
];

// -------------------------------------------------------------- the helpers ---

/** `&amp;` and friends, so a heading can be written as a human would type it. */
function decode(text) {
  return text
    .replace(/&(?:amp|#38);/g, "&")
    .replace(/&(?:lt|#60);/g, "<")
    .replace(/&(?:gt|#62);/g, ">")
    .replace(/&(?:quot|#34);/g, '"')
    .replace(/&(?:apos|#39|#x27);/g, "'")
    .replace(/&(?:nbsp|#160);/g, " ");
}

/** The text inside the first `<h1>`, without markup or entities. */
function firstHeading(body) {
  const match = body.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  if (match === null) return "";
  return decode(match[1].replace(/<[^>]*>/g, ""))
    .replace(/\s+/g, " ")
    .trim();
}

async function get(url) {
  return fetch(url, {
    redirect: "manual",
    headers: { "user-agent": "msst-guide-check-live" },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
}

// --------------------------------------------------------------- the checks ---

/**
 * Every problem found, as sentences a reader of the log can act on. The pass
 * takes the base URL and returns the list; an empty list is the whole point.
 */
async function inspect(base) {
  const problems = [];
  const where = (path) => `${base}${path}`;
  const loose = [];

  /** HTML pages: right status, relayed by us, and the page we expect. */
  const pages = new Map();
  for (const { path, heading } of PAGES) {
    let response;
    let body;
    try {
      response = await get(where(path));
      body = await response.text();
    } catch (error) {
      problems.push(`${where(path)} — could not be reached (${error.message})`);
      continue;
    }
    pages.set(path, body);

    if (response.status !== 200) {
      problems.push(`${where(path)} — answered ${response.status}, not 200`);
      continue;
    }
    if (!(response.headers.get("content-type") || "").includes("text/html")) {
      problems.push(`${where(path)} — is not HTML (${response.headers.get("content-type")})`);
      continue;
    }
    const relay = response.headers.get("x-msst-proxy");
    if (relay === null) {
      problems.push(
        `${where(path)} — was not answered by the relay: no x-msst-proxy header.\n` +
          `      Something in the Pages deployment is serving this page as a static\n` +
          `      file, which is what a hand-built page left in the bundle looks like.`,
      );
    }
    const actual = firstHeading(body);
    if (actual !== heading) {
      problems.push(
        `${where(path)} — answered 200 with the wrong page.\n` +
          `      expected heading  ${heading}\n` +
          `      got               ${actual || "(no h1)"}`,
      );
    }
  }

  /** The CMS has to be behind all this: one hashed asset from the home page. */
  const home = pages.get("/");
  if (home !== undefined) {
    const asset = home.match(/\/_instatic\/[^"'\s)>]+\.(?:css|js)/);
    if (asset === null) {
      problems.push(
        `${where("/")} — references nothing under /_instatic/, so the CMS did not publish it:\n` +
          `      this is a page from somewhere else wearing the guide's address.`,
      );
    } else {
      try {
        const response = await get(`${base}${asset[0]}`);
        if (response.status !== 200) {
          problems.push(`${base}${asset[0]} — answered ${response.status}, so the CMS is not serving its assets`);
        }
      } catch (error) {
        problems.push(`${base}${asset[0]} — could not be reached (${error.message})`);
      }
    }
  }

  /** The pre-move addresses, and the editor path, are the relay's redirects. */
  for (const [from, to] of LEGACY) {
    let response;
    try {
      response = await get(where(from));
    } catch (error) {
      problems.push(`${where(from)} — could not be reached (${error.message})`);
      continue;
    }
    if (response.status !== 301 && response.status !== 308) {
      problems.push(`${where(from)} — answered ${response.status}, expected a permanent redirect to ${to}`);
      continue;
    }
    const location = response.headers.get("location") || "";
    let landed;
    try {
      landed = new URL(location, base);
    } catch {
      problems.push(`${where(from)} — redirects to something unparseable: ${location}`);
      continue;
    }
    if (landed.host !== new URL(base).host) {
      problems.push(`${where(from)} — redirects off this host (${location}); a reader's address bar should not move`);
    } else if (landed.pathname !== to) {
      problems.push(`${where(from)} — redirects to ${landed.pathname}, expected ${to}`);
    }
  }

  try {
    const response = await get(where("/admin/"));
    if (response.status !== 302 && response.status !== 301 && response.status !== 308) {
      problems.push(`${where("/admin/")} — answered ${response.status}; the editor lives on the CMS and this should redirect there`);
    } else if (new URL(response.headers.get("location") || "/", base).host === new URL(base).host) {
      problems.push(`${where("/admin/")} — redirects within this host; the editor's session and CSRF origin are the CMS's`);
    }
  } catch (error) {
    problems.push(`${where("/admin/")} — could not be reached (${error.message})`);
  }

  /** The two files this project answers itself, and what they claim. */
  try {
    const response = await get(where("/robots.txt"));
    const body = await response.text();
    if (response.status !== 200) {
      problems.push(`${where("/robots.txt")} — answered ${response.status}, not 200`);
    } else {
      const declared = body.match(/^\s*Sitemap:\s*(\S+)\s*$/m);
      if (declared === null) problems.push(`${where("/robots.txt")} — has no Sitemap: line`);
      else if (new URL(declared[1]).host !== new URL(base).host) {
        problems.push(`${where("/robots.txt")} — points at a sitemap on another host: ${declared[1]}`);
      }
    }
  } catch (error) {
    problems.push(`${where("/robots.txt")} — could not be reached (${error.message})`);
  }

  try {
    const response = await get(where("/sitemap.xml"));
    const body = await response.text();
    if (response.status !== 200) {
      problems.push(`${where("/sitemap.xml")} — answered ${response.status}, not 200`);
    } else {
      const locs = [...body.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)].map((m) => m[1]);
      if (locs.length === 0) problems.push(`${where("/sitemap.xml")} — lists no URLs`);
      const known = new Set(PAGES.map((page) => page.path));
      for (const loc of locs) {
        let url;
        try {
          url = new URL(loc);
        } catch {
          problems.push(`${where("/sitemap.xml")} — unparseable URL: ${loc}`);
          continue;
        }
        if (url.host !== new URL(base).host) {
          problems.push(`${where("/sitemap.xml")} — advertises another host: ${loc}`);
        } else if (!known.has(url.pathname.replace(/\/$/, "") || "/")) {
          loose.push(loc);
        }
      }
      if (loose.length) {
        problems.push(
          `${where("/sitemap.xml")} — advertises routes this check does not know:\n      ${loose.join("\n      ")}\n` +
            `      Either the guide gained a page (add it to tools/check-live.mjs and tools/seo.py)\n` +
            `      or the sitemap lists something the relay no longer answers.`,
        );
      }
    }
  } catch (error) {
    problems.push(`${where("/sitemap.xml")} — could not be reached (${error.message})`);
  }

  return problems;
}

// -------------------------------------------------------------------- main ---

const argv = process.argv.slice(2);
const opt = (name, fallback) => {
  const at = argv.indexOf(name);
  return at === -1 ? fallback : (argv[at + 1] ?? fallback);
};

const base = String(opt("--base", DEFAULT_BASE)).replace(/\/+$/, "");
const budget = Number(opt("--wait", "30"));
if (!Number.isFinite(budget) || budget < 0) {
  console.error("\n  ✗ --wait takes seconds, and cannot be negative\n");
  process.exit(1);
}

const deadlines = Date.now() + budget * 1000;
let problems = await inspect(base);
let attempts = 1;

// A deploy is not instantly everywhere, so give it the budget before calling a
// failure real. One that survives the whole budget is worth the noise.
while (problems.length > 0 && Date.now() + RETRY_PAUSE_MS <= deadlines) {
  await new Promise((resolve) => setTimeout(resolve, RETRY_PAUSE_MS));
  attempts += 1;
  problems = await inspect(base);
}

if (problems.length === 0) {
  console.log(`\n  ✓ ${base} is the guide, relayed from the CMS`);
  for (const { path } of PAGES) console.log(`      ${path === "/" ? base : base + path}`);
  console.log(`      ${PAGES.length} pages, the legacy redirects, /admin/, robots.txt and sitemap.xml`);
  console.log(`      checked in ${attempts} pass${attempts === 1 ? "" : "es"}\n`);
} else {
  console.error(`\n  ✗ ${base} is not serving the guide (${attempts} pass${attempts === 1 ? "" : "es"}):\n`);
  for (const problem of problems) console.error(`    • ${problem}`);
  console.error(
    `\n    The relay is \`_worker.js\` and the CMS is whatever \`INSTATIC_ORIGIN\` names —\n` +
      `    admin/INSTATIC-HOSTING.md has both, and what to check when the CMS is down.\n`,
  );
}

// Deliberately not `process.exit()`: on Windows that aborts the process (a libuv
// assertion) when it races the fetch sockets being torn down, turning a failed
// check into a crash with an unrecognisable exit code. Setting the code lets the
// runtime finish those handles first — and the exit code is what CI reads anyway.
process.exitCode = problems.length === 0 ? 0 : 1;
