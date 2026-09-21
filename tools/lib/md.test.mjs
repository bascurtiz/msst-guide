import test from "node:test";
import assert from "node:assert/strict";

import { parse } from "./html.mjs";
import { blocksToMd, mdToHtmlBlocks, mdToHtmlInlineBlock } from "./md.mjs";

/** HTML -> markdown -> HTML, the way the extractor and build do it. */
function roundTrip(html) {
  const source = `<article>${html}</article>`;
  const root = parse(source);
  const article = root.children.find((n) => n.type === "element");
  const ctx = { raw: [], notes: [] };
  const elements = article.children.filter((n) => n.type === "element");
  const md = blocksToMd(elements, ctx, source);
  const rebuilt = elements.map((el) => mdToHtmlBlocks(md, { tag: el.tag, attrsRaw: el.attrsRaw })).join("");
  return { md, html: rebuilt };
}

test("inline tags survive a round trip as the tags the site uses", () => {
  const input = "<p>Use <strong>bold</strong>, <em>emphasis</em>, <code>--model_type</code> and a "
    + '<a href="https://vast.ai" rel="noopener">rented GPU</a>.</p>';
  const { html } = roundTrip(input);
  assert.equal(
    html,
    "<p>Use <strong>bold</strong>, <em>emphasis</em>, <code>--model_type</code> and a "
    + '<a href="https://vast.ai" rel="noopener">rented GPU</a>.</p>',
  );
});

test("internal links get no rel, external ones do", () => {
  const { html } = roundTrip('<p>See <a href="data.html#dataset">Chapter 03</a> and <a href="https://py.org" rel="noopener">py</a>.</p>');
  assert.match(html, /<a href="data\.html#dataset">Chapter 03<\/a>/);
  assert.match(html, /<a href="https:\/\/py\.org" rel="noopener">py<\/a>/);
});

test("entities and angle brackets survive", () => {
  const { md, html } = roundTrip("<p>Setup &amp; config &gt; anything, with a &lt; sign.</p>");
  assert.ok(md.startsWith("Setup & config"), md);
  assert.equal(html, "<p>Setup &amp; config &gt; anything, with a &lt; sign.</p>");
});

test("markdown-active characters in prose stay literal", () => {
  const { html } = roundTrip("<p>2*3 is 6, dim_t has an underscore, and [brackets] are fine.</p>");
  assert.equal(html, "<p>2*3 is 6, dim_t has an underscore, and [brackets] are fine.</p>");
});

test("presentational inline tags pass through as raw HTML", () => {
  const { md, html } = roundTrip('<p>Config <b>holds</b> the recipe and <span class="k">Step 02</span> follows.</p>');
  assert.match(md, /<b>holds<\/b>/);
  assert.match(md, /<span class="k">Step 02<\/span>/);
  assert.equal(html, '<p>Config <b>holds</b> the recipe and <span class="k">Step 02</span> follows.</p>');
});

test("a run of paragraphs becomes markdown blocks and keeps the slot's class", () => {
  const source = '<article><p class="lead-in">One.</p><p class="lead-in">Two.</p></article>';
  const root = parse(source);
  const article = root.children.find((n) => n.type === "element");
  const paragraphs = article.children.filter((n) => n.type === "element");
  const ctx = { raw: [], notes: [] };
  const md = blocksToMd(paragraphs, ctx, source);
  assert.equal(md, "One.\n\nTwo.");
  assert.equal(
    mdToHtmlBlocks(md, { tag: "p", attrsRaw: ' class="lead-in"' }),
    '<p class="lead-in">One.</p>\n<p>Two.</p>',
  );
  assert.equal(
    mdToHtmlBlocks("Kept.", { tag: "p", attrsRaw: ' style="margin-top:12px"' }),
    '<p style="margin-top:12px">Kept.</p>',
  );
});

test("the author can add paragraphs, lists and quotes", () => {
  const md = "First paragraph.\n\nSecond paragraph with **bold**.\n\n- one\n- two\n\n> quoted";
  const html = mdToHtmlBlocks(md, { tag: "p" });
  assert.equal(
    html,
    "<p>First paragraph.</p>\n<p>Second paragraph with <strong>bold</strong>.</p>\n"
    + "<ul>\n<li>one</li>\n<li>two</li>\n</ul>\n<blockquote><p>quoted</p></blockquote>",
  );
});

test("tables render inside the site's scroll wrapper", () => {
  const html = mdToHtmlBlocks("| Rate | Keeps |\n| --- | --- |\n| 44 100 | 22 050 Hz |\n", { tag: "p" });
  assert.match(html, /<div class="table-scroll">/);
  assert.match(html, /<th>Rate<\/th><th>Keeps<\/th>/);
  assert.match(html, /<td>44 100<\/td><td>22 050 Hz<\/td>/);
});

test("a heading typed into an inline slot is flattened, not nested", () => {
  assert.equal(mdToHtmlInlineBlock("## Get the code\nsecond line"), "Get the code\nsecond line");
  assert.equal(mdToHtmlInlineBlock("- a bullet"), "a bullet");
  assert.equal(mdToHtmlInlineBlock("Use `dim_t` here"), "Use <code>dim_t</code> here");
});

test("an empty slot renders nothing so a block can be deleted", () => {
  assert.equal(mdToHtmlBlocks("", { tag: "p" }), "");
  assert.equal(mdToHtmlBlocks("   \n\n ", { tag: "p" }), "");
});

test("unclosed emphasis and stray brackets degrade to text", () => {
  assert.equal(mdToHtmlInlineBlock("a * b"), "a * b");
  assert.equal(mdToHtmlInlineBlock("see [this"), "see [this");
  assert.equal(mdToHtmlInlineBlock("2 < 3"), "2 &lt; 3");
});
