#!/usr/bin/env node
/**
 * check-voice.mjs — count the sentence shapes that make prose read as
 * confident and empty, so a review can argue with numbers instead of taste.
 *
 * Read-only: it opens the paths it is given and prints. Nothing is rewritten,
 * nothing is gated on by default.
 *
 *   node packages/core/scripts/check-voice.mjs <path...>
 *   node packages/core/scripts/check-voice.mjs <path...> --json
 *   node packages/core/scripts/check-voice.mjs --patterns
 *   node packages/core/scripts/check-voice.mjs <path...> --fail-above <rate>
 *
 * What it counts, per file and per 1000 words:
 *
 *   - hits of each catalogue pattern (see PATTERNS: `--patterns` prints the
 *     table, each row carrying one line on what the pattern costs the reader;
 *     a hit is one scanned sentence, counted once however many of the row's
 *     spellings it contains)
 *   - sentences longer than thirty words (`long-sentence`)
 *   - sentences with no digit, no capitalised name and no quoted string
 *     (`empty-sentence`): the sentence that asserts a feeling where a fact
 *     would have to stand
 *   - U+2014 per 1000 words (`em-dash`)
 *   - the mean sentence length, in words
 *
 * The population is prose, not source: markdown loses its frontmatter, fenced
 * blocks, HTML comments and link targets; a source file contributes its
 * comments and nothing else. A heading is scanned for patterns but is not a
 * sentence, so it is outside the sentence counts and the mean.
 *
 * Approximations, stated because the numbers are comparative rather than
 * forensic: the sentence splitter needs whitespace after the terminator and a
 * capital, digit or opening quote after it, so a wrapped line without terminal
 * punctuation joins the next one and an abbreviation that ends a line is read
 * as an ending; a `//` inside a string literal is read as a comment; a URL
 * inside a sentence is stripped to nothing before the sentence is measured.
 *
 * Exit codes:
 *   0 — report printed (the default), or every file at or below the threshold
 *   1 — `--fail-above` was given and a file's catalogue-hit rate is above it
 *   2 — usage error, or a path that cannot be read
 *
 * `--fail-above <rate>` is the seat a release decides. This script sets no
 * threshold and no pipeline runs it as a gate yet: the flag exists so a later
 * release can turn the number into one without editing this file. The rate is
 * the file's total catalogue hits per 1000 words; the structural counters
 * (`long-sentence`, `empty-sentence`, `em-dash`) are reported and are not part
 * of the gated number, because a long sentence can be a good one.
 */
import { readFileSync, statSync } from "node:fs";
import { extname, resolve } from "node:path";

/** Longest sentence the instrument treats as within the catalogue's line. */
const LONG_SENTENCE_WORDS = 30;

/**
 * The catalogue, as data. Each row is one sentence shape the tone-quality skill
 * names, the regexes that find it, and the line a reader of the table needs to
 * judge a hit. Word boundaries are Unicode property escapes, not `\b`: `\b` is
 * defined on ASCII word characters, so it never fires at the edge of a Russian
 * word.
 */
const PATTERNS = [
  {
    id: "importance-para",
    cost: "tells the reader what to feel about the fact, so the fact stops doing its own work",
    regexes: [
      /(?<![\p{L}])почему\s+это\s+важн(?:о|ее)(?![\p{L}])/iu,
      /(?<![\p{L}])это\s+важно\s+(?:потому|ведь|для)(?![\p{L}])/iu,
      /\bwhy\s+(?:this|it)\s+matters\b/i,
      /\bit(?:'s| is)\s+important\s+to\s+note\b/i,
      /^[\s>*_#"'(\[-]*(?:why\s+(?:this|it)\s+matters|the\s+importance|почему\s+это\s+важно)\b/im,
    ],
  },
  {
    id: "revelation-frame",
    cost: "announces a discovery where an ordinary thing is being described, so the reader pays for a drumroll",
    regexes: [
      /(?<![\p{L}])это\s+не\s+просто(?![\p{L}])/iu,
      /\b(?:is|are|was|were|isn't|aren't|wasn't)\s+(?:not\s+(?:just|merely|simply)|more\s+than\s+just)\b/i,
    ],
  },
  {
    id: "empty-intensifier",
    cost: "adds emphasis where a number or a name would have added information",
    regexes: [
      /(?<![\p{L}])(?:во\s+многом|абсолютно|принципиально|существенно)(?![\p{L}])/iu,
      /\b(?:fundamentally|crucially|profoundly|dramatically|significantly|substantially|very\s+much)\b/i,
    ],
  },
  {
    id: "process-narration",
    cost: "walks through the steps the instrument takes, or the author took, where the result belonged",
    regexes: [
      /^[\s>*_#"'\[(-]*it\s+(?:reads|walks|prints|emits|counts|writes|returns|compares|parses|scans)\b/im,
      /^[\s>*_#"'\[(-]*(?:then\s+|first,?\s+|next,?\s+|finally,?\s+)?(?:i|we)\s+(?:then\s+)?(?:ran|run|read|opened|grepped|checked|compared|wrote|edited|reran|re-ran|built|installed|pasted|scanned|counted|measured)\b/im,
      /^[\s"'«„“\[(-]*(?:я|мы)\s+(?:запустил|запустили|прочитал|прочитали|открыл|открыли|сравнил|сравнили|проверил|проверили)(?![\p{L}])/imu,
    ],
  },
  {
    id: "dead-metaphor",
    cost: "borrows a picture and returns no mechanism, so the reader carries the image instead of the fact",
    regexes: [
      /\b(?:backbone|north\s+star|lifeblood|linchpin|engine\s+of|the\s+glue\s+that)\b/i,
      /\bat\s+the\s+heart\s+of\b/i,
    ],
  },
  {
    id: "deleted-actor",
    cost: "drops the agent, so nobody can ask who decided, on what evidence, or when",
    regexes: [
      /(?<![\p{L}])было\s+(?:принято|решено|сделано|проведено|выполнено)(?![\p{L}])/iu,
      /\b(?:it|this|that)\s+(?:was|were|has\s+been|had\s+been)\s+(?:made|decided|agreed|chosen|required|handled|fixed|added|removed|accepted)\b(?![\s\S]*\bby\b)/iu,
      /\b(?:a|the)\s+(?:decision|choice)\s+was\s+(?:made|taken)\b/i,
    ],
  },
];

/**
 * Structural counters. They carry ids and costs like the patterns do, because
 * a table column with no stated meaning is a number nobody can act on.
 */
const METRICS = [
  {
    id: "long-sentence",
    cost: `a clause chain past ${LONG_SENTENCE_WORDS} words makes the reader hold the subject while the modifiers run`,
  },
  {
    id: "empty-sentence",
    cost: "carries no digit, name or quotation, so it asserts a feeling where a fact would have to stand",
  },
  { id: "em-dash", cost: "pauses that a period or a comma would have made, at a density readers learn to skip" },
];

/** Every id the report carries, patterns first, then the structural counters. */
const IDS = [...PATTERNS.map((p) => p.id), ...METRICS.map((m) => m.id)];

const CODE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);
const MARKDOWN_EXTENSIONS = new Set([".md", ".markdown"]);

// ── Prose extraction ────────────────────────────────────────────────────────

const FENCE = /^\s*(?:```|~~~)/;
const TABLE_RULE = /^\s*\|?[\s:|-]+\|[\s:|-]*$/;
const LIST_ITEM = /^\s*(?:[-*+]|\d+[.)])\s+/;
const HEADING = /^\s*#{1,6}\s+/;

/** Strip the markup that is not prose but keeps its words. */
function cleanInline(line) {
  return line
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Split a markdown file into blocks of prose. A heading is its own block and is
 * marked as one; a list item, a table row and a paragraph after a blank line all
 * start a new block, so wrapped lines join and separate items never do.
 */
function markdownBlocks(text) {
  const lines = text.split(/\r?\n/);
  const blocks = [];
  let pending = "";
  let inFence = false;
  let inComment = false;
  let frontmatter = lines[0] === "---";

  const flush = () => {
    const body = pending.trim();
    if (body) blocks.push({ heading: false, text: body });
    pending = "";
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (frontmatter) {
      if (i > 0 && line.trim() === "---") frontmatter = false;
      continue;
    }
    if (inComment) {
      if (line.includes("-->")) inComment = false;
      continue;
    }
    if (line.trim().startsWith("<!--")) {
      flush();
      if (!line.includes("-->")) inComment = true;
      continue;
    }
    if (FENCE.test(line)) {
      flush();
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    if (!line.trim()) {
      flush();
      continue;
    }
    if (TABLE_RULE.test(line)) {
      flush();
      continue;
    }
    if (HEADING.test(line)) {
      flush();
      const body = cleanInline(line.replace(HEADING, ""));
      if (body) blocks.push({ heading: true, text: body });
      continue;
    }
    if (LIST_ITEM.test(line) || line.trim().startsWith("|")) {
      flush();
      pending = line.replace(/^\s*(?:[-*+]|\d+[.)])\s+/, "").replace(/^\s*\|/, " ");
      continue;
    }
    pending = pending ? `${pending} ${line.trim()}` : line.trim();
  }
  flush();
  return blocks;
}

/** A source file contributes its comments: the code is the tool's, not the prose's. */
function commentBlocks(text) {
  const blocks = [];
  let pending = [];

  const flush = () => {
    const body = cleanInline(pending.join(" "));
    if (body) blocks.push({ heading: false, text: body });
    pending = [];
  };

  // Consecutive line comments are one paragraph: a wrapped comment whose lines
  // were measured separately would read as a run of short empty sentences.
  for (const raw of text.split(/\r?\n/)) {
    const trimmed = raw.trim();
    if (!trimmed.startsWith("//")) {
      flush();
      continue;
    }
    const body = trimmed.replace(/^\/+\s?/, "");
    if (body) pending.push(body);
    else flush();
  }
  flush();

  for (const match of text.matchAll(/\/\*([\s\S]*?)\*\//g)) {
    for (const para of match[1].split(/\n\s*\n/)) {
      const body = cleanInline(
        para
          .split(/\r?\n/)
          .map((line) => line.replace(/^\s*\*+\s?/, ""))
          .join(" "),
      );
      if (body) blocks.push({ heading: false, text: body });
    }
  }
  return blocks;
}

function blocksFor(path, text) {
  const ext = extname(path).toLowerCase();
  if (MARKDOWN_EXTENSIONS.has(ext)) return markdownBlocks(text);
  if (CODE_EXTENSIONS.has(ext)) return commentBlocks(text);
  return markdownBlocks(text);
}

// ── Sentence splitting ──────────────────────────────────────────────────────

const ABBREVIATION = /(?:^|[\s(])(?:e\.g|i\.e|vs|cf|etc|approx|fig|no|eds|см|т\.е|т\.к)\.$/i;

/**
 * Split prose into sentences. A terminator only ends a sentence when what
 * follows can open one: whitespace, then a capital, a digit or an opening
 * quote. That one rule keeps versions (`0.43.31`), paths and lowercase
 * continuations from being counted as endings.
 */
function sentencesOf(text) {
  const out = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch !== "." && ch !== "!" && ch !== "?" && ch !== "\u2026") continue;
    const rest = text.slice(i + 1);
    if (!/^\s/.test(rest)) continue;
    const opening = rest.replace(/^\s+/, "");
    if (!opening) break;
    if (!/^["'«„”“(\[]?[\p{Lu}\p{N}]/u.test(opening)) continue;
    const head = text.slice(start, i + 1);
    if (ABBREVIATION.test(head)) continue;
    if (head.trim()) out.push(head.trim());
    start = i + 1;
  }
  const tail = text.slice(start).trim();
  if (tail) out.push(tail);
  return out;
}

const wordCount = (text) => text.split(/\s+/).filter((t) => /[\p{L}\p{N}]/u.test(t)).length;

function isEmptySentence(sentence) {
  if (/[\p{N}]/u.test(sentence)) return false;
  if (/["'`„“”«»]/.test(sentence)) return false;
  const tokens = sentence.split(/\s+/).filter(Boolean).slice(1);
  return !tokens.some((token) => /^[\p{Lu}]/u.test(token.replace(/^[^\p{L}\p{N}]+/u, "")));
}

// ── Measurement ─────────────────────────────────────────────────────────────

function measure(path, text) {
  const counts = Object.fromEntries(IDS.map((id) => [id, 0]));
  let words = 0;
  let sentenceWords = 0;
  let sentences = 0;

  const blocks = blocksFor(path, text);
  const prose = blocks.map((b) => b.text).join("\n");
  words = wordCount(prose);
  counts["em-dash"] = (prose.match(/\u2014/g) ?? []).length;

  // A hit is a sentence the shape appears in, counted once: two synonyms in one
  // row must not report two, and a row counts sentences rather than glyph runs.
  const scan = (target) => {
    for (const row of PATTERNS) {
      if (row.regexes.some((regex) => regex.test(target))) counts[row.id] += 1;
    }
  };

  for (const block of blocks) {
    if (block.heading) {
      scan(block.text);
      continue;
    }
    for (const sentence of sentencesOf(block.text)) {
      scan(sentence);
      const length = wordCount(sentence);
      sentenceWords += length;
      sentences += 1;
      if (length > LONG_SENTENCE_WORDS) counts["long-sentence"] += 1;
      if (isEmptySentence(sentence)) counts["empty-sentence"] += 1;
    }
  }

  const per1000 = Object.fromEntries(
    IDS.map((id) => [id, words === 0 ? 0 : (counts[id] * 1000) / words]),
  );
  return {
    path,
    words,
    sentences,
    meanSentenceLength: sentences === 0 ? 0 : sentenceWords / sentences,
    counts,
    per1000,
    catalogueHits: PATTERNS.reduce((sum, p) => sum + counts[p.id], 0),
    catalogueRate: words === 0 ? 0 : (PATTERNS.reduce((sum, p) => sum + counts[p.id], 0) * 1000) / words,
  };
}

// ── Table ───────────────────────────────────────────────────────────────────

const COLUMNS = [
  ["imp", "importance-para"],
  ["rev", "revelation-frame"],
  ["int", "empty-intensifier"],
  ["prc", "process-narration"],
  ["mta", "dead-metaphor"],
  ["act", "deleted-actor"],
  ["lng", "long-sentence"],
  ["emp", "empty-sentence"],
  ["emd", "em-dash"],
];

function printTable(rows) {
  const pathWidth = Math.max(4, ...rows.map((r) => r.path.length));
  const head = [
    "file".padEnd(pathWidth),
    "words".padStart(7),
    ...COLUMNS.map(([short]) => short.padStart(6)),
    "mean".padStart(7),
  ].join(" ");
  console.log(head);
  for (const row of rows) {
    const line = [
      row.path.padEnd(pathWidth),
      String(row.words).padStart(7),
      ...COLUMNS.map(([, id]) => row.per1000[id].toFixed(2).padStart(6)),
      row.meanSentenceLength.toFixed(1).padStart(7),
    ].join(" ");
    console.log(line);
  }
  console.log(
    "\ncolumns are hits per 1000 words; mean is words per sentence. `--patterns` prints what each id costs the reader.",
  );
}

function printPatterns() {
  console.log("id                 cost");
  for (const row of [...PATTERNS, ...METRICS]) {
    console.log(`${row.id.padEnd(18)} ${row.cost}`);
  }
}

// ── CLI ─────────────────────────────────────────────────────────────────────

function usage(message) {
  if (message) console.error(`check-voice: ${message}`);
  console.error(
    "usage: check-voice.mjs <path...> [--json] [--patterns] [--fail-above <rate>]",
  );
  process.exit(2);
}

const args = process.argv.slice(2);
const paths = [];
let json = false;
let printPatternList = false;
let failAbove = null;

for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === "--json") json = true;
  else if (arg === "--patterns") printPatternList = true;
  else if (arg === "--fail-above") {
    const value = args[++i];
    const rate = Number(value);
    if (value === undefined || !Number.isFinite(rate) || rate < 0) usage("--fail-above needs a non-negative rate");
    failAbove = rate;
  } else if (arg === "--help" || arg === "-h") {
    printPatterns();
    process.exit(0);
  } else if (arg.startsWith("-")) usage(`unknown flag ${arg}`);
  else paths.push(arg);
}

if (paths.length === 0 && !printPatternList) usage("no paths");

const rows = [];
for (const path of paths) {
  const absolute = resolve(path);
  let text;
  try {
    if (!statSync(absolute).isFile()) usage(`${path} is not a file`);
    text = readFileSync(absolute, "utf-8");
  } catch (error) {
    usage(`${path}: ${error.message}`);
  }
  rows.push(measure(path, text));
}

const above = failAbove === null ? [] : rows.filter((row) => row.catalogueRate > failAbove);

if (json) {
  process.stdout.write(
    `${JSON.stringify(
      {
        patterns: PATTERNS.map(({ id, cost }) => ({ id, cost })),
        metrics: METRICS.map(({ id, cost }) => ({ id, cost })),
        files: rows,
        failAbove,
        above: above.map((row) => row.path),
      },
      null,
      2,
    )}\n`,
  );
} else if (rows.length > 0) {
  printTable(rows);
  if (printPatternList) {
    console.log("");
    printPatterns();
  }
  if (failAbove !== null) {
    console.log(`\n--fail-above ${failAbove}: ${above.length === 0 ? "no file above it" : `${above.length} file(s) above it`}`);
  }
} else if (printPatternList) {
  printPatterns();
}

process.exit(above.length === 0 ? 0 : 1);
