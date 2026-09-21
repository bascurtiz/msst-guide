#!/usr/bin/env node
/**
 * Render the site.
 *
 *   src/pages/*.html      layout: markup, diagrams, code samples, widgets
 *   content/pages/*.json  prose, as markdown
 *        ->  *.html at the repository root, plus the search index and the
 *            ?v= asset stamps
 *
 * The repository root is the published site: Cloudflare Pages serves it as-is,
 * so there is no host-side build step to configure and no output directory to
 * point at the wrong folder. The pages at the root are generated files — edit
 * the template or the content, never the root page.
 *
 * Runs on Node alone, with no dependencies, so it also works in a build
 * container that has nothing else installed.
 *
 *   node tools/build.mjs            render the pages
 *   node tools/build.mjs --check    report whether the pages are up to date
 */

import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

import { detectEol } from "./lib/html.mjs";
import { mdToHtmlBlocks, mdToHtmlInlineBlock } from "./lib/md.mjs";
import { localRefs, resolveInRoot } from "./lib/refs.mjs";
import { PAGES, buildSearchIndex } from "./lib/search-index.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC_DIR = path.join(ROOT, "src", "pages");
const CONTENT_DIR = path.join(ROOT, "content", "pages");
const INDEX_FILE = path.join(ROOT, "assets", "js", "search-index.js");
const STAMPED = ["assets/css/site.css", "assets/js/site.js", "assets/js/search-index.js"];

// Three slot kinds: `prose` (a run of blocks the renderer rebuilds from
// markdown), `inline` (text inside an element the template keeps) and `code` (a
// whole block of markup the content file owns outright). The attribute group
// must not be able to cross "<" or ">", or a single marker would swallow every
// following one.
const MARKER = /<!--c:([A-Za-z0-9._-]+):(prose|inline|code)(?::([a-zA-Z0-9]+))?(?:\|([^|<>]*))?-->/g;

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function md5(file) {
  return createHash("md5").update(fs.readFileSync(file)).digest("hex").slice(0, 8);
}

function readContent(page) {
  const file = path.join(CONTENT_DIR, `${page}.json`);
  if (!fs.existsSync(file)) throw new Error(`missing content file: content/pages/${page}.json`);
  const content = JSON.parse(fs.readFileSync(file, "utf8"));
  const blocks = new Map();
  for (const section of content.sections || []) {
    const entries = [section.heading, ...(section.blocks || []), ...(section.codes || [])];
    for (const block of entries.filter(Boolean)) {
      if (blocks.has(block.key)) throw new Error(`${page}.json: duplicate block key ${block.key}`);
      blocks.set(block.key, block);
    }
  }
  return { content, blocks };
}

/** Fill one page's markers from its content, and report any drift. */
function renderPage(page, problems) {
  const templateFile = path.join(SRC_DIR, `${page}.html`);
  const template = fs.readFileSync(templateFile, "utf8");
  const eol = detectEol(template);
  const { blocks } = readContent(page);
  const used = new Set();

  const rendered = template.replace(MARKER, (whole, key, mode, tag, attrsRaw, offset, source) => {
    const block = blocks.get(key);
    if (!block) {
      problems.push(`${page}: template slot ${key} has no entry in content/pages/${page}.json`);
      return whole;
    }
    used.add(key);
    // A code slot is markup the content file owns wholesale — the <pre>, the
    // syntax-colouring spans inside it and all — so it goes back in byte for
    // byte: no markdown pass, and no re-indenting that would strip the leading
    // spaces a code sample may be showing.
    if (mode === "code") {
      // A code field stores a string. Anything else — an editor that wrote
      // `{code, lang}` because a CMS option did not take — would otherwise
      // render as "[object Object]" and ship a broken sample, so fail the build
      // and name the entry instead.
      if (typeof block.code !== "string") {
        throw new Error(`${page}.json: ${key} is a code slot but its \`code\` is`
          + ` ${Array.isArray(block.code) ? "an array" : typeof block.code}, not a string`);
      }
      return block.code;
    }
    const markdown = String(block.md ?? "");
    if (mode !== "prose") return mdToHtmlInlineBlock(markdown);

    const html = mdToHtmlBlocks(markdown, { tag, attrsRaw }, eol);
    // Keep the generated page tidy: line the blocks up with the marker's own
    // indentation, except inside a code block, where leading spaces are content.
    if (html.includes("<pre")) return html;
    const indent = source.slice(source.lastIndexOf("\n", offset) + 1, offset);
    if (!/^[ \t]*$/.test(indent)) return html;
    return html.split("\n").map((line, i) => (i === 0 ? line : indent + line)).join("\n");
  });

  for (const key of blocks.keys()) {
    if (!used.has(key)) problems.push(`${page}: content entry ${key} has no slot in src/pages/${page}.html`);
  }
  if (MARKER.test(rendered)) {
    MARKER.lastIndex = 0;
    problems.push(`${page}: a slot marker survived rendering`);
  }

  const banner = `<!-- GENERATED by tools/build.mjs — edit src/pages/${page}.html for layout`
    + ` or content/pages/${page}.json for text, then re-run the build. -->`;
  const doctype = /<!doctype[^>]*>/i.exec(rendered);
  const withBanner = doctype
    ? `${rendered.slice(0, doctype.index + doctype[0].length)}${eol}${banner}${rendered.slice(doctype.index + doctype[0].length)}`
    : `${banner}${eol}${rendered}`;

  // one consistent line ending, matching the template the file came from
  return { html: withBanner.split(/\r?\n/).join(eol), eol };
}

function stamp(html, stamps) {
  let out = html;
  for (const [rel, hash] of Object.entries(stamps)) {
    out = out.replace(new RegExp(`${escapeRegExp(rel)}\\?v=[A-Za-z0-9._-]+`, "g"), `${rel}?v=${hash}`);
    out = out.replace(new RegExp(`((?:href|src)="${escapeRegExp(rel)})(?=")`, "g"), `$1?v=${hash}`);
  }
  return out;
}

/* ------------------------------------------------------ referenced files --- */

/**
 * The repository root *is* the site, so every local file a page points at has
 * to be in it. A wrong path in the sidebar or the pager is markup's problem and
 * markup is reviewed; a wrong path in *prose* is the author's, and he cannot see
 * it — he uploads in a browser, and a mistyped filename, or an upload he never
 * committed, is a 404 that nobody notices until a reader does. So the build
 * fails the save and names the file, rather than leaving it to the packager (on
 * a connected Pages project, that would surface as a failed deploy instead).
 *
 * Fragments are deliberately not checked: `#dataset` staying in step with
 * `id="dataset"` is a property of the templates, and those ids are baked into
 * markup the author never touches. Which references are local, and where one
 * resolves, lives in ./lib/refs.mjs — unit tested, and shared in spirit with the
 * packager, which runs the same idea over the staged bundle.
 */
function auditRefs(file, html, problems) {
  for (const { url, target } of localRefs(html)) {
    if (!resolveInRoot(ROOT, target)) {
      problems.push(`${file}: ${url} points at a file that does not exist`);
    }
  }
}

function build({ write }) {
  const problems = [];
  const rendered = new Map();

  for (const { file } of PAGES) {
    const page = file.replace(/\.html$/, "");
    rendered.set(page, renderPage(page, problems));
  }

  // the index is built from the rendered pages, so it sees the current text
  const index = buildSearchIndex(
    PAGES.map(({ file, short, title }) => ({
      file, short, title, html: rendered.get(file.replace(/\.html$/, "")).html,
    })),
  );

  if (write) {
    fs.mkdirSync(path.dirname(INDEX_FILE), { recursive: true });
    fs.writeFileSync(INDEX_FILE, index.js, "utf8");
  }
  const previousIndex = fs.existsSync(INDEX_FILE) ? fs.readFileSync(INDEX_FILE, "utf8") : null;
  const indexHash = createHash("md5").update(index.js).digest("hex").slice(0, 8);
  const stamps = {};
  for (const rel of STAMPED) {
    // the index is stamped from what it is about to become, not from disk
    stamps[rel] = rel === "assets/js/search-index.js" ? indexHash : md5(path.join(ROOT, rel));
  }

  const written = [];
  for (const { file } of PAGES) {
    const page = file.replace(/\.html$/, "");
    const html = stamp(rendered.get(page).html, stamps);
    // audit exactly the bytes destined for disk, not the pre-stamp markup
    auditRefs(file, html, problems);
    const target = path.join(ROOT, file);
    const before = fs.existsSync(target) ? fs.readFileSync(target, "utf8") : null;
    if (write) {
      fs.writeFileSync(target, html, "utf8");
      written.push(`${file}${before === html ? " (unchanged)" : ""}`);
    } else if (before !== html) {
      written.push(file);
    }
  }

  return { problems, stamps, index, written, previousIndex };
}

function main() {
  const check = process.argv.includes("--check");
  const { problems, stamps, index, written, previousIndex } = build({ write: !check });

  for (const problem of problems) console.error(`  ! ${problem}`);

  console.log(`  ${PAGES.length} pages · ${index.payload.blocks.length} search blocks · `
    + `${Object.values(stamps).map((hash) => `?v=${hash}`).join(" ")}`);
  if (check) {
    const indexChanged = previousIndex !== index.js;
    if (written.length || indexChanged) {
      console.log("  OUT OF DATE:");
      for (const file of written) console.log(`    ${file}`);
      if (indexChanged) console.log("    assets/js/search-index.js");
      process.exitCode = 1;
    } else {
      console.log("  pages, index and stamps are current");
    }
  } else {
    console.log(`  rendered ${written.join(", ")}`);
  }

  if (problems.length) process.exitCode = 1;
}

main();
