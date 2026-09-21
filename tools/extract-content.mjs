#!/usr/bin/env node
/**
 * Split the hand-built pages into templates plus editable content.
 *
 *   index.html  ->  src/pages/index.html   (layout, diagrams, markup)
 *               ->  content/pages/index.json (the prose, as markdown)
 *
 * A slot is either:
 *
 *   prose   a run of sibling <p>/<blockquote>/<figcaption> with the same class.
 *           The whole run is replaced by a marker, so the author can add or
 *           remove paragraphs and the build renders the blocks back.
 *   inline  an element that owns its styling and only holds text (a heading, a
 *           list item, a card title, a label). Its inner text is replaced by a
 *           marker; the element and its attributes stay in the template.
 *   code    a whole <pre> element — a command, a config block, a stack trace.
 *           The element, the spans that colour it and its own indentation all
 *           move into the content file as one string, because those colours come
 *           from markup that no highlighter could rebuild from plain text.
 *
 * Everything else — SVG diagrams, tables, the calculator, the table of contents,
 * navigation and page chrome — is left in the template and is not editable from
 * the CMS.
 *
 * This runs once. Re-running would overwrite content, so it refuses unless
 * --force is given. After it has run, edit the templates by hand and use
 * tools/build.mjs to render the pages.
 *
 *   node tools/extract-content.mjs [--force] [--report] [--from DIR]
 *
 * --from reads the pages from somewhere other than the repository root, which
 * is what you want when the root already holds generated output and you need to
 * re-extract from the original hand-written pages.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { BLOCK_TAGS, attr, classList, detectEol, hasVisibleText, parse, textOf } from "./lib/html.mjs";
import { blocksToMd, inlineToMd, mdToHtmlInlineBlock, plainText } from "./lib/md.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC_DIR = path.join(ROOT, "src", "pages");
const CONTENT_DIR = path.join(ROOT, "content", "pages");

const PAGES = ["index", "data", "setup", "training", "reference"];

/** Subtrees that are navigation, decoration or a widget, never prose. */
const SKIP_TAGS = new Set([
  "script", "style", "svg", "head", "title", "meta", "nav", "header", "footer",
  "button", "select", "option", "input", "textarea", "noscript", "code",
  "table", "iframe", "video", "audio",
]);

// `<pre>` is deliberately absent above: it is a `code` slot of its own, and it
// has to be handled explicitly, because a <pre> full of <span> would otherwise
// be walked into and each coloured word would become an inline slot.

/** Same idea, by class — matches what the search index treats as chrome. */
const SKIP_CLASSES = new Set([
  "toc", "pager", "crumbs", "skip", "progress", "backtop", "site-nav",
  "search-overlay", "drawer", "dlabel", "term-bar", "code-bar", "tree-bar",
  "copy", "chips", "cta", "header-actions", "switch", "brand", "calc", "term",
  "code", "tree", "table-scroll", "ico", "flow-note",
]);

/** Elements whose text an author may edit when they hold nothing else. */
const SLOT_TAGS = new Set([
  "div", "a", "span", "b", "strong", "em", "i", "small", "sup", "sub", "mark",
  "kbd", "abbr", "cite", "q", "u", "li", "dt", "dd", "h1", "h2", "h3", "h4",
  "h5", "h6",
]);

const PROSE_TAGS = new Set(["p", "blockquote", "figcaption"]);

/** Children that must stay in the template, so their parent cannot be a slot. */
const FORCED_DESCEND = new Set([...BLOCK_TAGS, "button", "select", "input", "textarea"]);

const KIND_LABEL = {
  code: "Code sample",
  h1: "Page title", h2: "Chapter heading", h3: "Subheading", h4: "Heading",
  h5: "Card title", h6: "Label", p: "Paragraph", quote: "Quote",
  caption: "Caption", figcaption: "Caption", li: "List item", dt: "Glossary term",
  dd: "Definition", b: "Bold label", strong: "Bold text", em: "Italic text",
  i: "Italic label", span: "Label", a: "Link text", div: "Label",
  small: "Small note", sup: "Superscript", sub: "Subscript",
};

function snippet(text, max = 64) {
  const flat = String(text).replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  return `${flat.slice(0, max - 1).replace(/[\s,;:.-]+$/, "")}…`;
}

function slug(text) {
  return String(text).normalize("NFKD")
    .replace(/[^\w\s-]/g, "").trim().toLowerCase()
    .replace(/[-_\s]+/g, "-").slice(0, 40) || "section";
}

function isSkipped(node) {
  if (SKIP_TAGS.has(node.tag)) return true;
  return classList(node).some((cls) => SKIP_CLASSES.has(cls));
}

function hasForcedChild(node) {
  return node.children.some((child) => child.type === "element" && FORCED_DESCEND.has(child.tag));
}

/**
 * A wrapper element (a stat box, a card row) is descended into rather than
 * swallowed as one slot — but only when it holds no text of its own, so a
 * `<div>Where <b>beginners</b> get stuck</div>` stays a single editable string.
 */
function shouldDescendInto(node) {
  const kids = node.children.filter((child) => child.type === "element");
  if (!kids.length) return false;
  const ownText = node.children.filter((child) => child.type === "text").map((child) => child.raw).join("");
  if (/[A-Za-z0-9]/.test(ownText)) return false;
  return kids.every((child) => SLOT_TAGS.has(child.tag) || isSkipped(child));
}

/* --------------------------------------------------------------- extraction */

function extractPage(page, fromDir) {
  const file = path.join(fromDir, `${page}.html`);
  const source = fs.readFileSync(file, "utf8");
  const eol = detectEol(source);
  const root = parse(source);

  let main = null;
  (function find(node) {
    for (const child of node.children) {
      if (child.type !== "element") continue;
      if (child.tag === "main") { main = child; return; }
      find(child);
      if (main) return;
    }
  })(root);
  if (!main) throw new Error(`${page}.html has no <main>`);

  const sections = [];
  let section = { id: "head", label: "Page head", heading: null, blocks: [], codes: [] };
  sections.push(section);
  const usedSectionIds = new Set(["head"]);
  const splices = [];
  const report = { unhandled: [], skipped: [], raw: [], notes: [], sections: 0, prose: 0, inline: 0, code: 0 };
  const ctx = { raw: report.raw, notes: report.notes };
  let seq = 0;

  const nextKey = (kind) => {
    seq += 1;
    return `${page}.${section.id}.${kind}.${String(seq).padStart(2, "0")}`;
  };

  const addBlock = (key, md, label) => {
    section.blocks.push({ key, label, md });
  };

  function startSection(h2node) {
    const text = plainText(h2node);
    let id = attr(h2node, "id") || slug(text);
    let candidate = id;
    let n = 2;
    while (usedSectionIds.has(candidate)) candidate = `${id}-${n++}`;
    usedSectionIds.add(candidate);
    id = candidate;
    section = { id, label: text || id, heading: null, blocks: [], codes: [] };
    sections.push(section);
    report.sections += 1;
    return id;
  }

  // Only identical siblings join a run: the marker carries one attribute
  // string for all of them, so differing attributes need their own slots.
  function takeRun(kids, start) {
    const first = kids[start];
    const run = [first];
    let i = start + 1;
    while (i < kids.length) {
      const next = kids[i];
      if (next.type === "text" && !next.raw.trim()) { i += 1; continue; }
      if (next.type !== "element") break;
      if (next.tag !== first.tag) break;
      if (next.attrsRaw !== first.attrsRaw) break;
      run.push(next);
      i += 1;
    }
    return { run, next: i };
  }

  function makeProseSlot(run, tag, attrsRaw) {
    const kind = tag === "p" ? "p" : tag === "blockquote" ? "quote" : "caption";
    const key = nextKey(kind);
    // the marker is a comment, so an attribute containing "<" or ">" would end it
    if (/[<>]/.test(attrsRaw || "")) {
      throw new Error(`${page}.html: <${tag}> near line 1 has an attribute containing "<" or ">"`
        + ` — the slot marker cannot carry it`);
    }
    const md = blocksToMd(run, ctx, source);
    const label = `${KIND_LABEL[kind] || "Paragraph"} · ${snippet(plainText(run[0]))}`;
    splices.push({
      start: run[0].start,
      end: run[run.length - 1].end,
      // the marker carries the element's own attributes, so class and inline
      // style survive the round trip even though the element is replaced
      text: `<!--c:${key}:prose:${tag}|${attrsRaw ?? ""}-->`,
    });
    addBlock(key, md, label);
    report.prose += 1;
    return key;
  }

  /** A whole <pre> becomes one code slot: markup, indentation and all. */
  function makeCodeSlot(node) {
    const key = nextKey("code");
    const markup = source.slice(node.start, node.end);
    splices.push({ start: node.start, end: node.end, text: `<!--c:${key}:code-->` });
    section.codes.push({ key, label: `${KIND_LABEL.code} · ${snippet(plainText(node))}`, code: markup });
    report.code += 1;
    return key;
  }

  function makeInlineSlot(node) {
    const key = nextKey(node.tag);
    const md = inlineToMd(node.children, ctx, source).trim();
    const heading = `${KIND_LABEL[node.tag] || "Text"} · `;
    const label = node.tag.startsWith("h")
      ? `${KIND_LABEL[node.tag]} · ${snippet(mdToHtmlInlineBlock(md).replace(/<[^>]+>/g, ""), 70)}`
      : `${heading}${snippet(plainText(node))}`;
    splices.push({ start: node.openEnd, end: node.innerEnd, text: `<!--c:${key}:inline-->` });
    addBlock(key, md, label);
    report.inline += 1;
    return key;
  }

  function visit(parent) {
    const kids = parent.children;
    let i = 0;
    while (i < kids.length) {
      const node = kids[i];

      if (node.type === "text") {
        if (/[A-Za-z0-9]/.test(node.raw) && !/^\s*$/.test(node.raw)) {
          report.unhandled.push({ parent: parent.tag, cls: classList(parent).join("."), text: snippet(node.raw, 80) });
        }
        i += 1;
        continue;
      }
      if (node.type !== "element") { i += 1; continue; }

      if (isSkipped(node)) {
        const text = textOf(node);
        report.skipped.push({ tag: node.tag, cls: classList(node).join("."), text: snippet(text, 70) });
        // A widget can still hold a code sample (`<div class="code"><pre>…`), and
        // a sample is a code slot, so descend a level to pick up a <pre> child
        // while the rest of the widget stays out of the CMS.
        for (const child of node.children) {
          if (child.type === "element" && child.tag === "pre" && !attr(child, "id")) makeCodeSlot(child);
        }
        i += 1;
        continue;
      }

      if (PROSE_TAGS.has(node.tag)) {
        const { run, next } = takeRun(kids, i);
        makeProseSlot(run, node.tag, node.attrsRaw);
        i = next;
        continue;
      }

      if (node.tag === "pre") {
        // An `id` marks output a widget's script writes into, not a sample.
        if (!attr(node, "id")) makeCodeSlot(node);
        i += 1;
        continue;
      }

      if (hasForcedChild(node) || shouldDescendInto(node) || !SLOT_TAGS.has(node.tag)) {
        visit(node);
        i += 1;
        continue;
      }

      if (hasVisibleText(node)) {
        if (node.tag === "h2") startSection(node);
        const key = makeInlineSlot(node);
        if ((node.tag === "h1" || node.tag === "h2") && !section.heading) {
          section.heading = pick(section, key);
        }
        i += 1;
        continue;
      }

      visit(node);
      i += 1;
    }
  }

  /** Move a just-created block into the section's heading field. */
  function pick(target, key) {
    const index = target.blocks.findIndex((block) => block.key === key);
    if (index < 0) return null;
    return target.blocks.splice(index, 1)[0];
  }

  visit(main);

  // Templates are built back-to-front so earlier offsets stay valid.
  let template = source;
  for (const splice of [...splices].sort((a, b) => b.start - a.start)) {
    template = template.slice(0, splice.start) + splice.text + template.slice(splice.end);
  }
  template = addBanner(template, eol, page);

  const head = sections[0].heading;
  const pageTitle = head ? mdToHtmlInlineBlock(head.md).replace(/<[^>]+>/g, "").trim() : page;

  return {
    template,
    content: {
      page,
      title: pageTitle,
      source: `src/pages/${page}.html`,
      sections,
    },
    report,
  };
}

function addBanner(template, eol, page) {
  const banner = `<!-- TEMPLATE — not served. Prose lives in content/pages/${page}.json;`
    + ` render the pages with: node tools/build.mjs -->`;
  const doctype = /<!doctype[^>]*>/i.exec(template);
  if (!doctype) return `${banner}${eol}${template}`;
  const at = doctype.index + doctype[0].length;
  return template.slice(0, at) + eol + banner + template.slice(at);
}

/* --------------------------------------------------------------------- main */

function main() {
  const force = process.argv.includes("--force");
  const report = process.argv.includes("--report");
  const fromIndex = process.argv.indexOf("--from");
  const fromDir = fromIndex > -1 ? path.resolve(process.argv[fromIndex + 1]) : ROOT;
  if (fromIndex > -1 && !fs.existsSync(path.join(fromDir, "index.html"))) {
    console.error(`--from ${fromDir} does not contain index.html`);
    process.exit(1);
  }
  console.log(`  reading pages from ${fromDir}`);

  if (fs.existsSync(SRC_DIR) && !force) {
    const existing = fs.readdirSync(SRC_DIR).filter((f) => f.endsWith(".html"));
    if (existing.length) {
      console.error(`src/pages already holds ${existing.length} template(s) — refusing to overwrite.`);
      console.error("Templates are the source of truth once they exist; pass --force only if you");
      console.error("really mean to re-extract from the generated pages at the repository root.");
      process.exit(1);
    }
  }

  fs.mkdirSync(SRC_DIR, { recursive: true });
  fs.mkdirSync(CONTENT_DIR, { recursive: true });

  const totals = { prose: 0, inline: 0, code: 0, sections: 0, raw: 0, unhandled: 0, skipped: 0 };
  for (const page of PAGES) {
    const result = extractPage(page, fromDir);
    fs.writeFileSync(path.join(SRC_DIR, `${page}.html`), result.template, "utf8");
    fs.writeFileSync(
      path.join(CONTENT_DIR, `${page}.json`),
      `${JSON.stringify(result.content, null, 2)}\n`,
      "utf8",
    );

    const { report: r } = result;
    totals.prose += r.prose;
    totals.inline += r.inline;
    totals.code += r.code;
    totals.sections += r.sections;
    totals.raw += r.raw.length;
    totals.unhandled += r.unhandled.length;
    totals.skipped += r.skipped.length;

    console.log(`  ${page.padEnd(10)} ${String(r.sections + 1).padStart(2)} sections · `
      + `${String(r.prose).padStart(3)} prose · ${String(r.inline).padStart(3)} inline · `
      + `${String(r.code).padStart(2)} code · `
      + `${String(r.raw.length).padStart(2)} raw HTML · ${r.unhandled.length} unhandled`);

    if (report) {
      for (const item of r.unhandled) console.log(`      UNHANDLED text in <${item.parent} class="${item.cls}">: ${item.text}`);
      for (const item of new Set(r.raw.map((x) => x.tag))) console.log(`      raw passthrough: <${item}>`);
      for (const item of new Set(r.notes)) console.log(`      note: ${item}`);
    }
  }

  console.log(`\n  ${totals.sections + PAGES.length} sections, ${totals.prose} prose slots, `
    + `${totals.inline} inline slots, ${totals.code} code slots, ${totals.raw} raw-HTML passthroughs`);
  console.log(`  templates -> src/pages/   content -> content/pages/`);
  if (totals.unhandled) {
    console.log(`  ${totals.unhandled} text node(s) were not picked up — rerun with --report to see them.`);
  }
}

main();
