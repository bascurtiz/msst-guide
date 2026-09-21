/**
 * Build the client-side search index for the guide.
 *
 * A faithful port of tools/build-search-index.py, kept line-for-line in spirit
 * so the emitted index is identical: the Python script needs a Python runtime,
 * and the site is built on a host where only Node is guaranteed. The index is
 * emitted as a plain script that defines window.MSST_INDEX (a fetch() of each
 * page would not work from a file:// path).
 *
 * Shape:
 *
 *   {
 *     "generated": "2026-09-21",
 *     "pages": [{ "file": "data.html", "short": "Before you train",
 *                 "title": "Before you train — requirements & datasets" }],
 *     "blocks": [                      # one entry per paragraph / list item /
 *       [1,                            #   table cell / code block / heading
 *        "Building a dataset",         # section (<h2>) it lives in
 *        "dataset",                    # that section's anchor id ("" if none)
 *        "Type 2 layout",              # nearest <h3> above it ("" if none)
 *        "text",                       # "head" for a heading, else "text"
 *        "…"]                           # collapsed plain text
 *     ]
 *   }
 */

import { attr, classList, decode, parse } from "./html.mjs";

export const PAGES = [
  { file: "index.html", short: "Home", title: "Training Audio Source Separation Models — A Practical Guide" },
  { file: "data.html", short: "Before you train", title: "Before you train — requirements and datasets" },
  { file: "setup.html", short: "Setup & config", title: "Setup and configuration — the repository, commands and YAML" },
  { file: "training.html", short: "Training runs", title: "Training runs — from scratch, fine-tuning, local and cloud" },
  { file: "reference.html", short: "Reference", title: "Reference — troubleshooting, glossary and metrics" },
];

/** Sub-trees that carry navigation or decoration, not content. */
const SKIP_TAGS = new Set([
  "script", "style", "svg", "nav", "header", "footer", "head", "title", "meta",
  "button", "select", "option", "noscript",
]);
const SKIP_CLASSES = new Set([
  "toc", "pager", "crumbs", "skip", "progress", "backtop", "site-nav",
  "search-overlay", "drawer", "dlabel", "term-bar", "code-bar", "tree-bar",
  "copy", "chips", "cta", "flow-note", "header-actions", "switch", "brand",
]);
const BLOCK_TAGS = new Set([
  "p", "li", "td", "th", "pre", "figcaption", "dt", "dd", "blockquote",
  "h1", "h2", "h3", "h4", "h5", "h6",
]);
const HEADING_TAGS = new Set(["h1", "h2", "h3", "h4", "h5", "h6"]);

const collapse = (text) => text.replace(/\s+/g, " ").trim();

function isSkipped(node) {
  if (SKIP_TAGS.has(node.tag)) return true;
  return classList(node).some((cls) => SKIP_CLASSES.has(cls));
}

function extract(html) {
  const blocks = [];
  const state = { stack: [], section: ["", "Overview"], context: "" };

  const pushText = (text) => {
    if (state.stack.length) state.stack[state.stack.length - 1].parts.push(text);
  };

  const closeBlock = (tag, node) => {
    const frame = state.stack.pop();
    const text = collapse(frame.parts.join(""));
    // A block whose text its parent already covers is not indexed twice.
    if (state.stack.length && text) {
      const parentText = state.stack[state.stack.length - 1].parts.join("").replace(/\s+/g, " ");
      if (parentText.includes(text)) return;
    }
    if (!text || !/[A-Za-z0-9]/.test(text)) return;

    if (tag === "h2") {
      state.section = [attr(node, "id") || "", text];
      state.context = "";
    } else if (tag === "h3") {
      state.context = text;
    }
    if (HEADING_TAGS.has(tag) && state.stack.length) {
      state.stack[state.stack.length - 1].parts.push(` ${text} `);
    }
    blocks.push({
      sec: state.section[1],
      id: state.section[0],
      ctx: state.context,
      kind: HEADING_TAGS.has(tag) ? "head" : "text",
      x: text.length <= 1200 ? text : text.slice(0, 1200).replace(/\s+\S*$/, ""),
    });
  };

  const visit = (node) => {
    for (const child of node.children) {
      if (child.type === "text") {
        pushText(decode(child.raw));
        continue;
      }
      if (child.type !== "element") continue;
      if (isSkipped(child)) continue;

      if (BLOCK_TAGS.has(child.tag)) {
        state.stack.push({ parts: [] });
        visit(child);
        closeBlock(child.tag, child);
        continue;
      }
      if (child.tag === "img") {
        pushText(` ${decode(attr(child, "alt") || "")} `);
        continue;
      }
      if (child.tag === "br" || child.tag === "hr") {
        pushText(" ");
        continue;
      }
      visit(child);
    }
  };

  visit({ children: parse(html).children });
  return blocks.filter((block) => block.x);
}

/**
 * Build the index payload and the script text.
 * `pages` is a list of { file, short, title, html }.
 */
export function buildSearchIndex(pages) {
  const out = { pages: [], blocks: [] };
  pages.forEach((page, index) => {
    out.pages.push({ file: page.file, short: page.short, title: page.title });
    for (const block of extract(page.html)) {
      out.blocks.push([index, block.sec, block.id, block.ctx, block.kind, block.x]);
    }
  });

  const payload = {
    generated: new Date().toISOString().slice(0, 10),
    pages: out.pages,
    blocks: out.blocks,
  };
  const js = "/* Generated by tools/build.mjs — do not edit by hand.\n"
    + "   Rebuild after editing content or a template:  node tools/build.mjs\n"
    + "   blocks: [pageIndex, section, sectionAnchor, subHeading, kind, text] */\n"
    + `window.MSST_INDEX=${JSON.stringify(payload)};\n`;

  return { payload, js };
}
