#!/usr/bin/env node
/**
 * Compare the CMS the guide is served from now with the one it is moving to —
 * page by page, asset by asset — while both are still up.
 *
 *     node tools/compare-hosts.mjs --to https://34-71-12-9.sslip.io
 *     node tools/compare-hosts.mjs --from https://old.example --to https://new.example
 *     node tools/compare-hosts.mjs --to https://new.example --paths /,/setup
 *
 * `--from` defaults to the relay's own default origin, read out of `_worker.js`:
 * that is the host readers are on right now, and it keeps being the right answer
 * as the file changes. `--to` is the new one, and it is required.
 *
 * This is step 2 of admin/MOVING-THE-CMS.md, and it exists for the one failure
 * that looks like success — an import that lands *most* of the site. A page that
 * never made it, a figure whose media did not travel, an SEO plugin that was not
 * reinstalled: every one of those shows a perfectly convincing page in a browser.
 * So both hosts are asked the same questions and the answers are compared, rather
 * than the new one being looked at on its own.
 *
 * `tools/check-live.mjs` is deliberately not this tool. It asserts relay
 * behaviour — the `x-msst-proxy` header, the `.html` redirects, `/admin` leaving
 * the host — none of which exists on a bare origin. Until the relay is pointed at
 * the new host these are two CMSes talking to nobody, and comparing them is the
 * only question that means anything.
 *
 * What is compared, and what a difference means:
 *
 *   - **A page answers 200 on both, with the same `<h1>`.** A different heading is
 *     a different page, which is what step 2 is for.
 *   - **The canonical URL, `og:url`, and the host `og:image` points at are
 *     unchanged.** All three are emitted by the SEO plugin from its own site
 *     settings, so a fresh install that has not had them re-entered falls back to
 *     *its own* origin and quietly tells crawlers and social previews to use the
 *     editor's address — the one import mistake that looks right in a browser. A
 *     *missing* canonical is the same finding one step earlier: the plugin is not
 *     installed yet. Only `og:image`'s host is compared, not the file, because the
 *     media library holds copies of that picture and any of them would do.
 *   - **The text is the same length, near enough.** Scripts and styles stripped,
 *     both hostnames normalised away, then measured. A page that lost a section is
 *     shorter, and nothing else in this list would tell you.
 *   - **Uploaded media is referenced by the same paths.** A storage path is an id
 *     the bundle carries across, so these must match exactly; anything only the old
 *     host serves is fetched from the new one to prove it really is missing.
 *   - **Every asset the new page references actually loads.** `/_instatic/` bundles
 *     are content-hashed, so their *names* may legitimately differ after an import;
 *     what must never happen is a page pointing at a file its host does not serve.
 *
 * Exits non-zero when something would be visible to a reader, so it can be a gate.
 * No dependencies — Node's own `fetch` is all this needs.
 */

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
let timeoutMs = 20_000;

/** Detail lines sit under the line they belong to, wherever they are printed. */
const indent = (text) => text.split("\n").join(`\n${' '.repeat(6)}`);

/** How much shorter a page has to be before it counts as having lost content. */
const TEXT_TOLERANCE = 0.98;

// -------------------------------------------------------------- the helpers ---

/** Colour only when a person is watching: this output ends up in logs and pipes. */
const coloured = process.stdout.isTTY === true;
const wrap = (code, text) => (coloured ? `\u001b[${code}m${text}\u001b[0m` : text);
const bold = (text) => wrap("1", text);
const dim = (text) => wrap("2", text);
const green = (text) => wrap("32", text);
const yellow = (text) => wrap("33", text);
const red = (text) => wrap("31", text);

function fail(message) {
  console.error(`\n  ${red("✗")} ${message}\n`);
  process.exit(1);
}

/** The relay's fallback origin, so `--from` does not have to be remembered. */
function relayOrigin() {
  const source = readFileSync(join(ROOT, "_worker.js"), "utf8");
  const match = source.match(/DEFAULT_ORIGIN\s*=\s*["']([^"']+)["']/);
  if (match === null) {
    fail("`_worker.js` names no DEFAULT_ORIGIN, so --from has no default. Pass it explicitly.");
  }
  return match[1].replace(/\/+$/, "");
}

/**
 * The routes the relay answers, read out of `_worker.js` rather than listed here:
 * the pages worth comparing are the ones a reader can actually reach.
 */
function relayRoutes() {
  const source = readFileSync(join(ROOT, "_worker.js"), "utf8");
  const match = source.match(/const\s+PAGE_ROUTES\s*=\s*new Set\(\[([^\]]*)\]\)/);
  if (match === null) fail("`_worker.js` no longer declares `PAGE_ROUTES`; pass --paths instead.");
  return match[1]
    .split(",")
    .map((name) => name.trim().replace(/^["']|["']$/g, ""))
    .filter(Boolean)
    .map((name) => (name === "index" ? "/" : `/${name}`));
}

/** `https://` unless a scheme is already there, and no trailing slash. */
function asOrigin(value) {
  const withScheme = /^https?:\/\//i.test(value) ? value : `https://${value}`;
  let url;
  try {
    url = new URL(withScheme);
  } catch {
    fail(`that is not a URL: ${value}`);
  }
  return url.origin;
}

function decode(text) {
  return text
    .replace(/&(?:amp|#38);/g, "&")
    .replace(/&(?:lt|#60);/g, "<")
    .replace(/&(?:gt|#62);/g, ">")
    .replace(/&(?:quot|#34);/g, '"')
    .replace(/&(?:apos|#39|#x27);/g, "'")
    .replace(/&(?:nbsp|#160);/g, " ")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)));
}

/** One attribute's value from a single tag, whichever order it was written in. */
function attr(tag, name) {
  const match = tag.match(new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i"));
  return match === null ? null : decode(match[1] ?? match[2] ?? match[3] ?? "");
}

function titleOf(html) {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return match === null ? "" : decode(match[1]).replace(/\s+/g, " ").trim();
}

function firstHeading(html) {
  const match = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  return match === null ? "" : decode(match[1].replace(/<[^>]*>/g, "")).replace(/\s+/g, " ").trim();
}

/**
 * What the SEO plugin puts in the head, which is where the site's own address
 * shows up. All three are read whichever order their attributes were written in.
 *
 * `og:image` is kept as its *host* rather than its whole URL: the picture is
 * chosen from the media library, which holds more than one copy of it, so the
 * asset id may legitimately differ between hosts — but the host it points at must
 * not, because that is the plugin's site address again.
 */
function headSignals(html) {
  let canonical = null;
  for (const tag of html.match(/<link\b[^>]*>/gi) ?? []) {
    if (/\brel\s*=\s*["']?canonical/i.test(tag)) canonical = attr(tag, "href") ?? canonical;
  }
  let ogUrl = null;
  let ogImage = null;
  for (const tag of html.match(/<meta\b[^>]*>/gi) ?? []) {
    if (/\bproperty\s*=\s*["']og:url["']/i.test(tag)) ogUrl = attr(tag, "content") ?? ogUrl;
    if (/\bproperty\s*=\s*["']og:image["']/i.test(tag)) ogImage = attr(tag, "content") ?? ogImage;
  }
  let ogImageHost = null;
  try {
    ogImageHost = ogImage === null ? null : new URL(ogImage).origin;
  } catch {
    ogImageHost = `unparseable: ${ogImage}`;
  }
  return { canonical, "og:url": ogUrl, "og:image host": ogImageHost };
}

/**
 * The page as words, for measuring whether it is all still there. Scripts and
 * styles go first — they are code, not content, and they differ between hosts for
 * harmless reasons — then markup, then both origins, which appear inside the prose
 * wherever a link is absolute.
 */
function textOf(html, origins) {
  let text = html
    .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]*>/g, " ");
  for (const origin of origins) text = text.split(origin).join("<host>");
  return decode(text).replace(/\s+/g, " ").trim();
}

/**
 * The assets a page asks for, as paths, keeping only the two families that come
 * from the CMS. Anything pointing at another host is somebody else's problem, and
 * a page's own `<link rel=canonical>` is handled as a head signal, not an asset.
 */
function assetsOf(html, pageUrl) {
  const found = new Set();
  const values = [];
  for (const match of html.matchAll(/\b(?:src|href)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>"']+))/gi)) {
    values.push(match[1] ?? match[2] ?? match[3] ?? "");
  }
  for (const match of html.matchAll(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^)'"]+))\s*\)/gi)) {
    values.push(match[1] ?? match[2] ?? match[3] ?? "");
  }
  for (const value of values) {
    let url;
    try {
      url = new URL(value, pageUrl);
    } catch {
      continue;
    }
    if (url.origin !== new URL(pageUrl).origin) continue;
    if (/^\/(?:_instatic|uploads)\//.test(url.pathname)) found.add(url.pathname);
  }
  return [...found].sort();
}

async function get(url) {
  const response = await fetch(url, {
    redirect: "manual",
    headers: { "user-agent": "msst-guide-compare-hosts" },
    signal: AbortSignal.timeout(timeoutMs),
  });
  return { response, body: await response.text() };
}

/** Everything one host says about one page, or why it could not say it. */
async function inspect(origin, path, origins) {
  const url = `${origin}${path}`;
  let response;
  let body;
  try {
    ({ response, body } = await get(url));
  } catch (error) {
    return { url, error: error.message };
  }
  if (response.status !== 200) return { url, status: response.status };
  const type = response.headers.get("content-type") ?? "";
  if (!type.includes("text/html")) return { url, status: response.status, type };
  return {
    url,
    status: 200,
    body,
    title: titleOf(body),
    heading: firstHeading(body),
    head: headSignals(body),
    text: textOf(body, origins),
    assets: assetsOf(body, url),
  };
}

// ---------------------------------------------------------------- the compare ---

const ASSET_LABEL = { "/_instatic/": "_instatic", "/uploads/": "uploads" };
const family = (asset) => ASSET_LABEL[asset.startsWith("/uploads/") ? "/uploads/" : "/_instatic/"];
const shortName = (asset) => asset.split("/").pop();

async function main() {
  const args = process.argv.slice(2);
  let from = null;
  let to = null;
  let paths = null;

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--from") from = args[++i];
    else if (arg === "--to") to = args[++i];
    else if (arg === "--paths") paths = args[++i];
    else if (arg === "--timeout") timeoutMs = Number(args[++i]) * 1000;
    else if (arg === "--help" || arg === "-h") {
      console.log(readFileSync(fileURLToPath(import.meta.url), "utf8").split("*/")[0]);
      return;
    } else fail(`unknown argument: ${arg} (try --help)`);
  }

  if (to === undefined || to === null) fail("--to is required: the origin the guide is moving to.");
  const oldOrigin = asOrigin(from ?? relayOrigin());
  const newOrigin = asOrigin(to);
  if (oldOrigin === newOrigin) {
    console.log(
      `\n  ${yellow("!")} --from and --to are the same host (${newOrigin}); ` +
        `every difference reported will be the tool comparing it with itself.\n`,
    );
  }
  const routeList = paths === null ? relayRoutes() : paths.split(",").map((p) => p.trim()).filter(Boolean);
  if (routeList.length === 0) fail("no routes to compare.");

  console.log(
    `\n${bold("==>")} ${oldOrigin} ${dim("→")} ${newOrigin}` +
      `\n    ${dim(`${routeList.length} route(s), assets fetched from the new host only`)}\n`,
  );

  const origins = [oldOrigin, newOrigin];
  const failures = [];
  const warnings = [];
  const checked = new Map();

  /** Every asset the new host is asked for, fetched once. */
  async function loadOnNew(asset) {
    if (!checked.has(asset)) {
      let entry;
      try {
        const { response, body } = await get(`${newOrigin}${asset}`);
        entry = { status: response.status, bytes: body.length };
      } catch (error) {
        entry = { status: 0, error: error.message };
      }
      checked.set(asset, entry);
    }
    return checked.get(asset);
  }

  for (const path of routeList) {
    const before = await inspect(oldOrigin, path, origins);
    const after = await inspect(newOrigin, path, origins);
    const problems = [];
    const notes = [];

    if (before.error !== undefined) {
      notes.push(`the old host could not be read (${before.error}) — nothing to compare against`);
    } else if (before.status !== 200) {
      notes.push(`the old host answered ${before.status} for this route`);
    }

    if (after.error !== undefined) {
      problems.push(`could not be reached on the new host (${after.error})`);
    } else if (after.status !== 200) {
      problems.push(`answered ${after.status} on the new host — this page did not make it across`);
    } else if (after.type !== undefined) {
      problems.push(`is not HTML on the new host (${after.type})`);
    } else {
      if (before.status === 200 && before.heading !== after.heading) {
        problems.push(
          `a different page.\n  old  ${before.heading || "(no h1)"}\n  new  ${after.heading || "(no h1)"}`,
        );
      }
      if (before.status === 200 && before.title !== after.title) {
        notes.push(`the title differs.\n  old  ${before.title}\n  new  ${after.title}`);
      }

      // The head signals are the plugin's, and they must not have moved.
      for (const [name, oldValue] of Object.entries(before.head ?? {})) {
        const newValue = after.head[name];
        if (oldValue === null) continue;
        if (newValue === null) {
          problems.push(
            `${name} is gone. The old host names ${oldValue} and the new one names nothing, ` +
              `which is what an SEO plugin that has not been reinstalled yet looks like.`,
          );
        } else if (newValue !== oldValue) {
          problems.push(
            `${name} changed.\n  old  ${oldValue}\n  new  ${newValue}\n  ` +
              `It has to keep naming the guide's address, or crawlers and social previews ` +
              `are pointed at a host that is not the guide. That value comes from the SEO ` +
              `plugin's own settings, which are per-install and have to be re-entered after ` +
              `an import.`,
          );
        }
      }

      // The text, which is the only thing that notices a lost section.
      if (before.status === 200 && before.text.length > 0) {
        const ratio = after.text.length / before.text.length;
        if (ratio < TEXT_TOLERANCE) {
          problems.push(
            `lost content: ${after.text.length.toLocaleString("en-US")} characters of text against ` +
              `the old host's ${before.text.length.toLocaleString("en-US")} ` +
              `(${Math.round((1 - ratio) * 100)}% missing).`,
          );
        } else if (after.text.length !== before.text.length) {
          notes.push(
            `text is ${after.text.length.toLocaleString("en-US")} characters against ` +
              `${before.text.length.toLocaleString("en-US")} — worth an eye, though within tolerance`,
          );
        }
      }

      // Assets: media paths must match because they are ids; hashed bundles may
      // be renamed, so what matters there is that the new host serves what it names.
      if (before.status === 200) {
        const oldSet = new Set(before.assets);
        const newSet = new Set(after.assets);
        for (const asset of oldSet) {
          if (newSet.has(asset) || !asset.startsWith("/uploads/")) continue;
          const loaded = await loadOnNew(asset);
          problems.push(
            `the new pages no longer reference ${asset} (${shortName(asset)}), and there it ` +
              `${loaded.status === 404 ? "404s" : `answers ${loaded.status || loaded.error}`} — ` +
              `a figure the old host still serves.`,
          );
        }
        const renamed = [...newSet].filter((asset) => !oldSet.has(asset) && !asset.startsWith("/uploads/"));
        if (renamed.length > 0) {
          notes.push(
            `${renamed.length} hashed bundle(s) with a new name ` +
              `(${renamed.slice(0, 3).map(shortName).join(", ")}${renamed.length > 3 ? ", …" : ""}) — expected after an import`,
          );
        }
      }

      for (const asset of after.assets) {
        const loaded = await loadOnNew(asset);
        if (loaded.status !== 200) {
          problems.push(`references ${asset}, which answers ${loaded.status || loaded.error} on the new host`);
        } else if (loaded.bytes === 0) {
          problems.push(`references ${asset}, which is empty on the new host`);
        }
      }
    }

    const counts = new Map();
    for (const asset of after.assets ?? []) counts.set(family(asset), (counts.get(family(asset)) ?? 0) + 1);
    const assetSummary = [...counts].map(([name, n]) => `${n} ${name}`).join(", ") || "no assets";
    const summary =
      after.error !== undefined || after.status !== 200
        ? ""
        : `${after.status} · ${after.text.length.toLocaleString("en-US")} chars · ${assetSummary}`;

    const glyph = problems.length > 0 ? "✗" : notes.length > 0 ? "!" : "✓";
    const paint = glyph === "✗" ? red : glyph === "!" ? yellow : green;
    console.log(`  ${paint(glyph)} ${path.padEnd(12)} ${dim(summary)}`);
    for (const problem of problems) console.log(`      ${indent(problem)}`);
    for (const note of notes) console.log(`      ${dim(indent(note))}`);

    if (problems.length > 0) failures.push(`${path} ${problems.join("\n")}`);
    if (notes.length > 0) warnings.push(path);
  }

  const assetsChecked = checked.size;
  console.log(
    `\n${bold("==>")} compared ${routeList.length} route(s) and ${assetsChecked} asset(s) from the new host`,
  );
  if (failures.length === 0) {
    console.log(
      `  ${green("✓")} the new host serves what the old one does` +
        (warnings.length > 0 ? `, with notes on ${warnings.length} route(s)` : "") +
        `\n`,
    );
    return;
  }
  console.log(`\n  ${red("✗")} ${failures.length} difference(s) a reader would see:\n`);
  for (const failure of failures) console.log(`      ${indent(failure)}`);
  console.log(`\n  ${dim("Fix these before step 3: the relay switch is what puts them in front of a reader.")}\n`);
  process.exitCode = 1;
}

await main();
