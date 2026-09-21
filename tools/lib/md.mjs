/**
 * Markdown <-> HTML for the guide's prose.
 *
 * Both directions are needed: `htmlToMd()` turns existing paragraphs into the
 * markdown the CMS edits, and `mdToHtml*()` renders that markdown back into the
 * pages. A round trip has to be lossless for the prose already on the site, so
 * inline conversion prefers markdown syntax where it maps to the exact tag the
 * site uses (`<strong>` -> `**`, `<em>` -> `*`, `<code>` -> backticks, `<a>` ->
 * a link) and falls back to raw inline HTML where it does not (`<b>`, `<i>`,
 * `<span class="k">`), which markdown passes through untouched.
 *
 * This is deliberately a subset of CommonMark — the part the guide's prose uses
 * and the part the CMS editor produces. Unknown syntax degrades to plain text
 * rather than throwing, because the author's edits must never break a build.
 */

import { BLOCK_TAGS, attr, classList, decode, escapeAttr, escapeText } from "./html.mjs";

/** Inline tags allowed to pass through as raw HTML, so styling survives. */
const RAW_INLINE = new Set([
  "a", "b", "br", "cite", "code", "del", "em", "i", "img", "ins", "kbd",
  "mark", "q", "s", "small", "span", "strong", "sub", "sup", "u", "wbr",
]);

const EXTERNAL_LINK = /^(https?:)?\/\//i;
const INLINE_SPECIAL = /[\\`!<>*_&\[\]\n]/;

/** Raw inline tags that contain further markup and must be copied wholesale. */
const RAW_INLINE_CONTAINERS = new Set(["svg"]);

/** Slot tags whose rendered paragraphs keep the slot's own wrapper. */
export const PARAGRAPH_LIKE = new Set(["p", "blockquote", "figcaption"]);

/* ------------------------------------------------------------------ helpers */

function mdUrl(url) {
  return /[\s()<>"]/.test(url) ? `<${url.replace(/>/g, "%3E")}>` : url;
}

function codeSpan(text) {
  const body = text.replace(/\u00a0/g, " ").replace(/\s+/g, " ");
  const longest = (body.match(/`+/g) || []).reduce((max, run) => Math.max(max, run.length), 0);
  const fence = "`".repeat(longest + 1);
  const pad = /^[`\s]|\s$/.test(body) ? " " : "";
  return `${fence}${pad}${body}${pad}${fence}`;
}

/** Escape text so markdown renders it as the characters it contains. */
export function escapeMdText(raw) {
  return decode(raw)
    .replace(/\u00a0/g, " ")
    .replace(/[\\`*_[\]<>]/g, (ch) => `\\${ch}`)
    .replace(/&(?=[a-zA-Z#][a-zA-Z0-9]*;)/g, "\\&")
    // a text line must not start with a block construct
    .replace(/^([ \t]*)([-+*>#]|\d+\.)(?=\s|$)/gm, (_m, indent, marker) => `${indent}\\${marker}`);
}

/* ------------------------------------------------------- html -> markdown */

function rawPassthrough(node, ctx, source) {
  const text = source.slice(node.start, node.end);
  ctx.raw.push({ tag: node.tag, text });
  return text;
}

export function inlineToMd(nodes, ctx, source) {
  let out = "";
  for (const node of nodes) {
    if (node.type === "text") out += escapeMdText(node.raw);
    else if (node.type === "element") out += elementToMd(node, ctx, source);
    else if (node.type === "comment") ctx.raw.push({ tag: "comment", text: node.raw });
  }
  return out;
}

function elementToMd(node, ctx, source) {
  const tag = node.tag;
  const classes = classList(node);
  const inner = () => inlineToMd(node.children, ctx, source);

  switch (tag) {
    case "strong":
      return `**${inner()}**`;
    case "em":
      return `*${inner()}*`;
    case "code":
      return codeSpan(decode(nodeText(node)));
    case "br":
      return "<br>";
    case "svg":
      // A whole icon or diagram, passed through untouched.
      return rawPassthrough(node, ctx, source);
    case "a": {
      const href = attr(node, "href");
      const extra = node.attrs.filter((a) => !["href", "title", "rel"].includes(a.name));
      const text = inner();
      if (!href || extra.length || classes.length || text.includes("<")) return rawPassthrough(node, ctx, source);
      const title = attr(node, "title");
      const suffix = title ? ` "${title.replace(/"/g, '\\"')}"` : "";
      return `[${text}](${mdUrl(href)}${suffix})`;
    }
    case "img": {
      const src = attr(node, "src");
      const extra = node.attrs.filter((a) => !["src", "alt", "title"].includes(a.name));
      if (!src || extra.length || classes.length) return rawPassthrough(node, ctx, source);
      const alt = (attr(node, "alt") || "").replace(/[[\]]/g, " ");
      const title = attr(node, "title");
      return `![${alt}](${mdUrl(src)}${title ? ` "${title.replace(/"/g, '\\"')}"` : ""})`;
    }
    case "span":
      return classes.length ? rawPassthrough(node, ctx, source) : inner();
    case "b":
    case "i":
    case "small":
    case "sup":
    case "sub":
    case "mark":
    case "kbd":
    case "abbr":
    case "u":
    case "cite":
    case "q":
      return rawPassthrough(node, ctx, source);
    default:
      if (BLOCK_TAGS.has(tag)) {
        // A block inside inline content: keep the text, drop the wrapper.
        ctx.notes.push(`dropped <${tag}> inside inline content`);
        return inner();
      }
      return rawPassthrough(node, ctx, source);
  }
}

function nodeText(node) {
  let out = "";
  for (const child of node.children) {
    if (child.type === "text") out += child.raw;
    else if (child.type === "element") out += nodeText(child);
  }
  return out;
}

/**
 * Convert a run of sibling block elements (paragraphs, quotes) into markdown
 * blocks separated by blank lines.
 */
export function blocksToMd(elements, ctx, source) {
  return elements
    .map((el) => {
      if (el.tag === "blockquote") {
        return el.children
          .filter((c) => c.type === "element")
          .flatMap((c) => inlineToMd(c.children, ctx, source).trim().split("\n"))
          .map((line) => `> ${line}`)
          .join("\n");
      }
      return inlineToMd(el.children, ctx, source).trim();
    })
    .join("\n\n");
}

/** Bare text (no markup) of a node's children, for labels. */
export function plainText(node) {
  return decode(nodeText(node)).replace(/[\s\u00a0]+/g, " ").trim();
}

/* ------------------------------------------------------- markdown -> html */

/** Inline markdown -> inline HTML. */
export function mdToHtmlInline(src) {
  const text = String(src ?? "").replace(/\r\n?/g, "\n");
  let out = "";
  let i = 0;

  while (i < text.length) {
    const ch = text[i];

    if (ch === "\\" && i + 1 < text.length && /[!-/:-@[-`{-~]/.test(text[i + 1])) {
      out += escapeText(text[i + 1]);
      i += 2;
      continue;
    }

    if (ch === "`") {
      const fence = /^`+/.exec(text.slice(i))[0];
      const close = text.indexOf(fence, i + fence.length);
      if (close > -1) {
        out += `<code>${escapeText(text.slice(i + fence.length, close).trim())}</code>`;
        i = close + fence.length;
        continue;
      }
    }

    if (ch === "!" && text[i + 1] === "[") {
      const link = parseLink(text, i + 1);
      if (link) {
        const alt = link.text.replace(/[*_`]/g, "");
        out += `<img src="${escapeAttr(link.url)}" alt="${escapeAttr(alt)}"${link.title ? ` title="${escapeAttr(link.title)}"` : ""}>`;
        i = link.end;
        continue;
      }
    }

    if (ch === "[") {
      const link = parseLink(text, i);
      if (link) {
        out += linkToHtml(link);
        i = link.end;
        continue;
      }
    }

    if (ch === "<") {
      const raw = /^<[/]?([a-zA-Z][a-zA-Z0-9-]*)((?:"[^"]*"|'[^']*'|[^>])*?)[/]?>/.exec(text.slice(i));
      const rawTag = raw && raw[1].toLowerCase();
      if (rawTag && RAW_INLINE.has(rawTag)) {
        out += raw[0];
        i += raw[0].length;
        continue;
      }
      // Elements that carry child markup (an icon, a diagram) pass through whole.
      if (rawTag && RAW_INLINE_CONTAINERS.has(rawTag) && !raw[0].startsWith("</")) {
        const close = text.indexOf(`</${rawTag}>`, i);
        if (close > -1) {
          const end = close + rawTag.length + 3;
          out += text.slice(i, end);
          i = end;
          continue;
        }
      }
      const auto = /^<((?:https?:\/\/|mailto:)[^>\s]+)>/.exec(text.slice(i));
      if (auto) {
        out += linkToHtml({ text: auto[1], url: auto[1] });
        i += auto[0].length;
        continue;
      }
      out += "&lt;";
      i += 1;
      continue;
    }

    if (ch === "*" || ch === "_") {
      const strong = text.startsWith(ch + ch, i);
      const marker = strong ? ch + ch : ch;
      const inner = matchDelimiter(text, i, marker, ch === "_" ? text[i - 1] : undefined);
      if (inner) {
        const rendered = mdToHtmlInline(inner.body);
        out += strong ? `<strong>${rendered}</strong>` : `<em>${rendered}</em>`;
        i = inner.end;
        continue;
      }
    }

    if (ch === "&") {
      const entity = /^&[a-zA-Z#][a-zA-Z0-9]*;/.exec(text.slice(i));
      if (entity) {
        out += entity[0];
        i += entity[0].length;
        continue;
      }
      out += "&amp;";
      i += 1;
      continue;
    }

    if (ch === "\n") {
      out += "\n";
      i += 1;
      continue;
    }

    // plain run up to the next character that could start something
    let j = i;
    while (j < text.length && !INLINE_SPECIAL.test(text[j])) j += 1;
    if (j === i) j = i + 1;
    out += escapeText(text.slice(i, j));
    i = j;
  }

  return out;
}

function linkToHtml(link) {
  const title = link.title ? ` title="${escapeAttr(link.title)}"` : "";
  const rel = EXTERNAL_LINK.test(link.url) ? ' rel="noopener"' : "";
  const body = link.html !== undefined ? link.html : mdToHtmlInline(link.text);
  return `<a href="${escapeAttr(link.url)}"${rel}${title}>${body}</a>`;
}

/** Find the closing delimiter of an emphasis run, or null. */
function matchDelimiter(text, start, marker, charBefore) {
  if (charBefore && /[A-Za-z0-9]/.test(charBefore)) return null;
  const after = text[start + marker.length];
  if (after === undefined || /\s/.test(after)) return null;
  let i = start + marker.length;
  while (i < text.length) {
    const found = text.indexOf(marker, i);
    if (found < 0) return null;
    if (text[found - 1] && !/\s/.test(text[found - 1])) {
      return { body: text.slice(start + marker.length, found), end: found + marker.length };
    }
    i = found + marker.length;
  }
  return null;
}

/** Parse `[text](dest "title")` starting at the "[" index. */
function parseLink(text, start) {
  let depth = 0;
  let i = start;
  for (; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === "\\") { i += 1; continue; }
    if (ch === "[") depth += 1;
    else if (ch === "]") {
      depth -= 1;
      if (depth === 0) break;
    }
  }
  if (i >= text.length || text[i + 1] !== "(") return null;
  let close = i + 2;
  let parens = 0;
  for (; close < text.length; close += 1) {
    const ch = text[close];
    if (ch === "\\") { close += 1; continue; }
    if (ch === "(") parens += 1;
    else if (ch === ")") {
      if (parens === 0) break;
      parens -= 1;
    }
  }
  if (close >= text.length) return null;
  const spec = text.slice(i + 2, close).trim();
  const match = /^(<[^>]*>|[^\s]+)(?:\s+"([^"]*)"|\s+'([^']*)')?$/.exec(spec);
  if (!match) return null;
  const url = match[1].replace(/^<|>$/g, "");
  const html = mdToHtmlInline(text.slice(start + 1, i));
  return { text: text.slice(start + 1, i), html, url, title: match[2] ?? match[3], end: close + 1 };
}

/* ------------------------------------------------------------- block level */

function parseBlocks(src) {
  const lines = String(src ?? "").replace(/\r\n?/g, "\n").split("\n");
  const blocks = [];
  let i = 0;

  const isBlank = (line) => /^\s*$/.test(line);

  while (i < lines.length) {
    const line = lines[i];

    if (isBlank(line)) { i += 1; continue; }

    const fence = /^\s*(```+|~~~+)\s*([\w-]*)\s*$/.exec(line);
    if (fence) {
      const body = [];
      i += 1;
      while (i < lines.length && !new RegExp(`^\\s*${fence[1][0]}{${fence[1].length},}\\s*$`).test(lines[i])) {
        body.push(lines[i]);
        i += 1;
      }
      i += 1;
      blocks.push({ type: "code", lines: body, info: fence[2] });
      continue;
    }

    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      blocks.push({ type: "hr" });
      i += 1;
      continue;
    }

    const heading = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (heading) {
      blocks.push({ type: "heading", level: heading[1].length, text: heading[2] });
      i += 1;
      continue;
    }

    if (/^\s{0,3}>/.test(line)) {
      const body = [];
      while (i < lines.length && (/^\s{0,3}>/.test(lines[i]) || (body.length && !isBlank(lines[i])))) {
        body.push(lines[i].replace(/^\s{0,3}>\s?/, ""));
        i += 1;
      }
      blocks.push({ type: "quote", text: body.join("\n") });
      continue;
    }

    if (isTableRow(line) && i + 1 < lines.length && isTableDelimiter(lines[i + 1])) {
      const head = splitRow(line);
      const rows = [];
      i += 2;
      while (i < lines.length && isTableRow(lines[i])) {
        rows.push(splitRow(lines[i]));
        i += 1;
      }
      blocks.push({ type: "table", head, rows });
      continue;
    }

    const listMatch = /^(\s*)([-*+]|\d+[.)])\s+/.exec(line);
    if (listMatch) {
      const ordered = /\d/.test(listMatch[2]);
      const items = [];
      while (i < lines.length) {
        const item = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(lines[i]);
        if (!item) {
          if (isBlank(lines[i])) break;
          if (items.length && /^\s+\S/.test(lines[i])) {
            items[items.length - 1].text += ` ${lines[i].trim()}`;
            i += 1;
            continue;
          }
          break;
        }
        const indent = item[1].replace(/\t/g, "  ").length;
        const text = item[3];
        if (indent >= 2 && items.length) {
          items[items.length - 1].children.push({ text, ordered: /\d/.test(item[2]), indent });
        } else {
          items.push({ text, children: [] });
        }
        i += 1;
      }
      blocks.push({ type: "list", ordered, items });
      continue;
    }

    const paragraph = [];
    while (i < lines.length && !isBlank(lines[i]) && !/^\s{0,3}(#{1,6}\s|>|(-{3,}|\*{3,}|_{3,})\s*$)/.test(lines[i])
      && !/^(\s*)([-*+]|\d+[.)])\s+/.test(lines[i])) {
      paragraph.push(lines[i]);
      i += 1;
    }
    if (!paragraph.length) paragraph.push(lines[i++]);
    blocks.push({ type: "paragraph", text: paragraph.join("\n").trim() });
  }

  return blocks;
}

const isTableRow = (line) => /^\s*\|.*\|\s*$/.test(line);
const isTableDelimiter = (line) => /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(line) && line.includes("-");
const splitRow = (line) => line.trim().replace(/^\||\|$/g, "").split("|").map((cell) => cell.trim());

function renderBlock(block, wrap, eol) {
  const tag = wrap && wrap.tag && PARAGRAPH_LIKE.has(wrap.tag) ? wrap.tag : null;
  // the slot's own attributes (`class="lead-in"`, `style="margin-top:12px"`)
  // are copied verbatim from the template on the first block
  const attrs = wrap && wrap.attrsRaw ? wrap.attrsRaw : "";

  switch (block.type) {
    case "heading":
      return `<h${block.level}>${mdToHtmlInline(block.text)}</h${block.level}>`;
    case "hr":
      return "<hr>";
    case "code":
      return `<pre><code>${escapeText(block.lines.join(eol))}</code></pre>`;
    case "quote":
      return `<blockquote><p>${mdToHtmlInline(block.text)}</p></blockquote>`;
    case "table": {
      const head = block.head.map((cell) => `<th>${mdToHtmlInline(cell)}</th>`).join("");
      const body = block.rows
        .map((row) => `<tr>${row.map((cell) => `<td>${mdToHtmlInline(cell)}</td>`).join("")}</tr>`)
        .join(eol);
      return `<div class="table-scroll">${eol}<table>${eol}<thead><tr>${head}</tr></thead>${eol}<tbody>${eol}${body}${eol}</tbody>${eol}</table>${eol}</div>`;
    }
    case "list": {
      const listTag = block.ordered ? "ol" : "ul";
      const items = block.items
        .map((item) => {
          const nested = item.children.length
            ? renderBlock({ type: "list", ordered: item.children[0].ordered, items: item.children.map((c) => ({ text: c.text, children: [] })) }, null, eol)
            : "";
          return `<li>${mdToHtmlInline(item.text)}${nested}</li>`;
        })
        .join(eol);
      return `<${listTag}${attrs}>${eol}${items}${eol}</${listTag}>`;
    }
    default: {
      const paragraphTag = tag || "p";
      return `<${paragraphTag}${attrs}>${mdToHtmlInline(block.text)}</${paragraphTag}>`;
    }
  }
}

/**
 * Render markdown as block HTML. `wrap` (optional) forces the first block's tag
 * and attributes, so a slot that replaces `<p class="lead-in">` keeps its
 * styling even if the author reflows the text into several paragraphs.
 */
export function mdToHtmlBlocks(md, wrap, eol = "\n") {
  const blocks = parseBlocks(md);
  const html = blocks.map((block, index) => renderBlock(block, index === 0 ? wrap : null, eol));
  return html.join(eol);
}

/**
 * Render markdown as inline HTML (no wrapping block element).
 *
 * Inline slots keep their wrapper element, so a block construct the author may
 * have reached for — a heading, a list, a quote — is flattened to its text
 * rather than injected as a nested block, which would be invalid inside, say,
 * a `<b>` or an `<h3>`.
 */
export function mdToHtmlInlineBlock(md) {
  const text = String(md ?? "")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/^\s*(?:#{1,6}\s+|>\s?|[-*+]\s+|\d+[.)]\s+)/, ""))
    .join("\n");
  return mdToHtmlInline(text);
}

export function mdToHtml(md, mode, wrap, eol = "\n") {
  return mode === "inline" ? mdToHtmlInlineBlock(md) : mdToHtmlBlocks(md, wrap, eol);
}
