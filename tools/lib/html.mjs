/**
 * A small, dependency-free HTML tokenizer that keeps exact source offsets.
 *
 * The content pipeline needs byte-precise positions rather than a DOM: the
 * extractor replaces prose elements with marker comments and the build puts
 * rendered text back in the same slots, so every node has to know where it
 * starts and ends in the original file.
 *
 * Only the shapes this site actually emits are handled (well-formed markup, no
 * optional-close tags, no foreign namespaces beyond self-closed SVG paths).
 * Unclosed elements are tolerated: they are closed at end of input.
 */

export const VOID_TAGS = new Set([
  "area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta",
  "param", "source", "track", "wbr",
]);

/** Elements whose content is raw text, not markup. */
const RAW_TEXT_TAGS = new Set(["script", "style"]);

/** Elements that make a parent a container rather than a single text run. */
export const BLOCK_TAGS = new Set([
  "address", "article", "aside", "blockquote", "caption", "details", "div", "dl",
  "dd", "dt", "fieldset", "figcaption", "figure", "footer", "form", "h1", "h2",
  "h3", "h4", "h5", "h6", "header", "hr", "li", "main", "nav", "ol", "p", "pre",
  "section", "svg", "table", "tbody", "td", "tfoot", "th", "thead", "tr", "ul",
]);

const NAMED_ENTITIES = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: "\u00a0",
  mdash: "\u2014", ndash: "\u2013", hellip: "\u2026", times: "\u00d7",
  middot: "\u00b7", rsquo: "\u2019", lsquo: "\u2018", rdquo: "\u201d",
  ldquo: "\u201c", laquo: "\u00ab", raquo: "\u00bb", deg: "\u00b0",
  copy: "\u00a9", reg: "\u00ae", trade: "\u2122", minus: "\u2212",
  sup2: "\u00b2", sup3: "\u00b3", frac12: "\u00bd", shy: "\u00ad",
  times2: "\u00d7", ge: "\u2265", le: "\u2264", neigh: "\u2249",
};

export function decode(str) {
  return String(str).replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z][a-zA-Z0-9]*);/g, (whole, body) => {
    if (body[0] === "#") {
      const code = body[1] === "x" || body[1] === "X"
        ? parseInt(body.slice(2), 16)
        : parseInt(body.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    const found = NAMED_ENTITIES[body.toLowerCase()];
    return found === undefined ? whole : found;
  });
}

export function escapeText(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\u00a0/g, "&nbsp;");
}

export function escapeAttr(str) {
  return escapeText(str).replace(/"/g, "&quot;");
}

function parseAttrs(text) {
  const attrs = [];
  const re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  let m;
  while ((m = re.exec(text))) {
    attrs.push({
      name: m[1].toLowerCase(),
      value: m[2] !== undefined ? m[2] : m[3] !== undefined ? m[3] : m[4] !== undefined ? m[4] : "",
      valueStart: m[2] !== undefined || m[3] !== undefined ? m.index + m[0].indexOf(m[2] ?? m[3]) : -1,
    });
  }
  return attrs;
}

/**
 * Parse a document into a tree. Returns the root element node, whose children
 * are the top-level nodes. Element nodes carry:
 *   start      index of "<"
 *   openEnd    index just past the ">" of the open tag
 *   innerEnd   index of the "<" of the close tag (or end of input)
 *   end        index just past the ">"
 */
export function parse(source) {
  const root = {
    type: "element", tag: "#root", attrs: [], attrsRaw: "", children: [],
    start: 0, openEnd: 0, innerEnd: source.length, end: source.length, parent: null,
  };
  const stack = [root];
  const top = () => stack[stack.length - 1];
  const addText = (raw, start) => {
    if (!raw) return;
    top().children.push({ type: "text", raw, start, end: start + raw.length });
  };

  let i = 0;
  while (i < source.length) {
    const lt = source.indexOf("<", i);
    if (lt < 0) {
      addText(source.slice(i), i);
      break;
    }
    if (lt > i) addText(source.slice(i, lt), i);

    if (source.startsWith("<!--", lt)) {
      const close = source.indexOf("-->", lt + 4);
      const end = close < 0 ? source.length : close + 3;
      top().children.push({ type: "comment", raw: source.slice(lt, end), start: lt, end });
      i = end;
      continue;
    }
    if (source.startsWith("<!", lt) || source.startsWith("<?", lt)) {
      const close = source.indexOf(">", lt);
      const end = close < 0 ? source.length : close + 1;
      const raw = source.slice(lt, end);
      top().children.push({
        type: /^<!doctype/i.test(raw) ? "doctype" : "declaration",
        raw, start: lt, end,
      });
      i = end;
      continue;
    }

    const match = /^<(\/?)([a-zA-Z][a-zA-Z0-9:_-]*)((?:[^>"']|"[^"]*"|'[^']*')*?)(\/?)>/.exec(source.slice(lt));
    if (!match) {
      // Not a tag after all — a bare "<" in text.
      addText("<", lt);
      i = lt + 1;
      continue;
    }
    const [full, closing, rawTag, attrsRaw, selfSlash] = match;
    const end = lt + full.length;
    const tag = rawTag.toLowerCase();

    if (closing) {
      for (let s = stack.length - 1; s > 0; s--) {
        if (stack[s].tag === tag) {
          const el = stack[s];
          el.closed = true;
          el.innerEnd = lt;
          el.end = end;
          stack.length = s;
          break;
        }
      }
      i = end;
      continue;
    }

    const el = {
      type: "element", tag, attrs: parseAttrs(attrsRaw), attrsRaw,
      children: [], parent: top(),
      start: lt, openEnd: end, innerEnd: null, end: null,
      selfClosing: Boolean(selfSlash) || VOID_TAGS.has(tag),
    };
    top().children.push(el);

    if (RAW_TEXT_TAGS.has(tag)) {
      const re = new RegExp(`</${tag}\\s*>`, "i");
      const found = re.exec(source.slice(end));
      const innerEnd = found ? end + found.index : source.length;
      if (innerEnd > end) {
        el.children.push({ type: "text", raw: source.slice(end, innerEnd), start: end, end: innerEnd, rawText: true });
      }
      el.innerEnd = innerEnd;
      el.end = innerEnd + (found ? found[0].length : 0);
      el.closed = Boolean(found);
      i = el.end;
      continue;
    }

    if (el.selfClosing) {
      el.innerEnd = end;
      el.end = end;
      el.closed = true;
      i = end;
      continue;
    }

    stack.push(el);
    i = end;
  }

  for (let s = stack.length - 1; s > 0; s--) {
    const el = stack[s];
    if (el.innerEnd == null) el.innerEnd = source.length;
    if (el.end == null) el.end = source.length;
  }
  return root;
}

export function attr(node, name) {
  const found = node.attrs.find((a) => a.name === name.toLowerCase());
  return found ? found.value : null;
}

export function classList(node) {
  const value = attr(node, "class");
  return value ? value.trim().split(/\s+/).filter(Boolean) : [];
}

export function hasClass(node, name) {
  return classList(node).includes(name);
}

export function rawOf(source, node) {
  return source.slice(node.start, node.end);
}

export function innerRaw(source, node) {
  return source.slice(node.openEnd, node.innerEnd);
}

/** Decoded, whitespace-collapsed text of a node (its own and its children's). */
export function textOf(node) {
  let out = "";
  const walk = (n) => {
    for (const child of n.children) {
      if (child.type === "text") out += child.raw;
      else if (child.type === "element") {
        if (child.tag === "br") out += " ";
        if (!RAW_TEXT_TAGS.has(child.tag)) walk(child);
      }
    }
  };
  walk(node);
  return decode(out).replace(/[\s\u00a0]+/g, " ").trim();
}

export function hasVisibleText(node) {
  return /[A-Za-z0-9]/.test(textOf(node));
}

/** Visit every element node, parents before children. */
export function walk(node, visit) {
  for (const child of node.children) {
    if (child.type !== "element") continue;
    visit(child);
    walk(child, visit);
  }
}

/** The line ending a document uses (defaults to "\n"). */
export function detectEol(source) {
  return source.includes("\r\n") ? "\r\n" : "\n";
}
