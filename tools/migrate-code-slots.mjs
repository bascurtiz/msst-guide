#!/usr/bin/env node
/**
 * Move the code samples out of the templates and into the content files.
 *
 *   src/pages/setup.html              <pre>…</pre>
 *     ->  <!--c:setup.repo.code.35:code-->
 *   content/pages/setup.json          sections[i].codes = [{ key, label, code }]
 *
 * Why the markup rather than the text: a sample's colour comes from the spans
 * inside it (`cmd` for a command, `f` for a flag, `ph` for a placeholder, `c`
 * for a comment, plus `k`/`eq`/`p` in the Python samples and `d`/`hl` in the
 * trees), and no rule can rebuild that from plain text — a highlighter would
 * repaint every block on the site. Handing the whole `<pre>` to the content file
 * leaves the render byte-identical, which is what makes
 * `node tools/build.mjs --check` a real answer to "did this change anything?".
 *
 * Runs once. It refuses a page whose template already holds a code marker, or
 * whose content already holds a populated `codes` array, because a second run
 * would move markup that is no longer there.
 *
 *   node tools/migrate-code-slots.mjs [--dry-run]
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { detectEol } from "./lib/html.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC_DIR = path.join(ROOT, "src", "pages");
const CONTENT_DIR = path.join(ROOT, "content", "pages");
const PAGES = ["index", "data", "setup", "training", "reference"];

/** A whole `<pre>` element. These bodies hold no nested `<pre>`, so the first
 *  close ends it. Non-greedy on purpose: a greedy match would swallow every
 *  sample between the first and last on the page. */
const PRE = /<pre(?:\s[^>]*)?>[\s\S]*?<\/pre>/g;
const H2 = /<h2[\s>]/g;
const MAIN = /<main\b[^>]*>[\s\S]*?<\/main>/;

function snippet(markup, max = 56) {
  const text = markup
    .replace(/<[^>]+>/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return text.length <= max ? text : `${text.slice(0, max - 1).replace(/[\s,;:.-]+$/, "")}…`;
}

function migrate(page, dryRun) {
  const templateFile = path.join(SRC_DIR, `${page}.html`);
  const contentFile = path.join(CONTENT_DIR, `${page}.json`);
  const template = fs.readFileSync(templateFile, "utf8");
  const content = JSON.parse(fs.readFileSync(contentFile, "utf8"));

  if (/:code-->/.test(template)) {
    throw new Error(`${page}: the template already has a code marker — already migrated?`);
  }
  const populated = (content.sections || []).filter((s) => (s.codes || []).length);
  if (populated.length) {
    throw new Error(`${page}.json: ${populated.length} section(s) already have code entries`);
  }

  const main = MAIN.exec(template);
  if (!main) throw new Error(`${page}.html has no <main>`);
  const mainStart = main.index;
  const mainEnd = main.index + main[0].length;

  // Sections are keyed positionally: the extractor pushed one section per <h2>
  // in document order, with the page head first, so the section a sample sits in
  // is the number of <h2>s before it — nought for the page head itself, which is
  // why index.html's hero terminal belongs to sections[0] and not sections[1].
  // Position is stabler than matching ids, which the extractor de-duplicates
  // with a `-2` suffix.
  const h2s = [...template.matchAll(H2)]
    .map((m) => m.index)
    .filter((at) => at > mainStart && at < mainEnd);
  const sections = content.sections || [];
  if (sections.length !== h2s.length + 1) {
    throw new Error(`${page}: ${h2s.length} <h2> in the template but ${sections.length} sections`
      + " in the content file — refusing to guess which sample belongs where");
  }
  const sectionOf = (at) => sections[h2s.filter((h2at) => h2at < at).length];

  const splices = [];
  const moved = [];
  let seq = 0;
  let outside = 0;
  let hooked = 0;

  for (const match of template.matchAll(PRE)) {
    const at = match.index;
    if (at < mainStart || at >= mainEnd) { outside += 1; continue; }
    // An `id` marks a <pre> that the page's own script writes into — a widget's
    // output — rather than a sample an author should edit. Leave those alone.
    if (/\sid=/.test(match[0].slice(0, match[0].indexOf(">")))) { hooked += 1; continue; }
    const section = sectionOf(at);
    if (!section) throw new Error(`${page}: no section found for a sample at offset ${at}`);
    seq += 1;
    const key = `${page}.${section.id}.code.${String(seq).padStart(2, "0")}`;
    const label = `Code sample · ${snippet(match[0])}`;
    splices.push({ start: at, end: at + match[0].length, text: `<!--c:${key}:code-->` });
    moved.push({ key, label, code: match[0], section });
  }

  if (!moved.length) throw new Error(`${page}: no code samples found inside <main>`);
  if (dryRun) return { page, moved, outside, hooked, written: false };

  // back to front, so earlier offsets stay valid
  let next = template;
  for (const splice of [...splices].sort((a, b) => b.start - a.start)) {
    next = next.slice(0, splice.start) + splice.text + next.slice(splice.end);
  }
  if ((next.match(/:code-->/g) || []).length !== moved.length) {
    throw new Error(`${page}: inserted ${(next.match(/:code-->/g) || []).length} markers for`
      + ` ${moved.length} samples — refusing to write a half-migrated template`);
  }

  // `codes` is appended to the sections that need it, in document order, so the
  // editor lists the samples under the section they sit in.
  for (const { key, label, code, section } of moved) {
    if (!section.codes) section.codes = [];
    section.codes.push({ key, label, code });
  }

  fs.writeFileSync(templateFile, next, "utf8");
  const eol = detectEol(fs.readFileSync(contentFile, "utf8"));
  fs.writeFileSync(contentFile, `${JSON.stringify(content, null, 2).split("\n").join(eol)}${eol}`, "utf8");

  return { page, moved, outside, hooked, written: true };
}

function main() {
  const dryRun = process.argv.includes("--dry-run");
  if (dryRun) console.log("  DRY RUN — nothing is written\n");

  // Plan every page first. A page that cannot be migrated has to stop the run
  // before any template is rewritten, or a failure in the middle would leave the
  // repository half-migrated: some pages moved, others not, and no single command
  // to undo it.
  const plans = [];
  const problems = [];
  for (const page of PAGES) {
    try {
      plans.push(migrate(page, true));
    } catch (error) {
      problems.push(error.message);
    }
  }
  if (problems.length) {
    for (const problem of problems) console.error(`  ! ${problem}`);
    console.error("\n  nothing was written");
    process.exitCode = 1;
    return;
  }

  let total = 0;
  for (const plan of plans) {
    const { page, moved, outside, hooked } = dryRun ? plan : migrate(plan.page, false);
    total += moved.length;
    console.log(`  ${page.padEnd(10)} ${String(moved.length).padStart(2)} code sample(s)`
      + `${dryRun ? " would move" : ""}`
      + `${outside ? ` · ${outside} outside <main>` : ""}`
      + `${hooked ? ` · ${hooked} widget output left in place` : ""}`);
    for (const { key, label } of moved) console.log(`      ${key.padEnd(30)} ${label}`);
  }

  console.log(`\n  ${total} code sample(s)${dryRun ? " to move" : " moved"}`);
  if (!dryRun) console.log("  now run: node tools/build.mjs --check");
}

main();
