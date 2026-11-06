/**
 * check-voice.mjs contract: the detector has to fire on the sentence shapes the
 * tone-quality catalogue names, and stay silent on prose that carries facts.
 *
 * Every case writes one file into a temp directory, runs the real CLI with
 * `--json`, and reads the numbers back, so the fixture pins the printed
 * surface rather than an internal function that could drift from it.
 *
 * A case "flags" when a catalogue pattern hits or a sentence runs past thirty
 * words. The empty-sentence count, the em-dash count and the mean sentence
 * length are reported by the instrument, and the cases that carry facts assert
 * them at zero; they are signals to read, not verdicts to pass.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const script = resolve(here, "..", "..", "..", "scripts", "check-voice.mjs");

/** Run the instrument over one inline file and return its JSON report. */
function scan(name, content) {
  const dir = mkdtempSync(join(tmpdir(), "check-voice-"));
  try {
    const file = join(dir, name);
    writeFileSync(file, content);
    const stdout = execFileSync(process.execPath, [script, "--json", file], {
      encoding: "utf-8",
    });
    const report = JSON.parse(stdout);
    assert.equal(report.files.length, 1, "one path in, one file row out");
    return report.files[0];
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const hits = (file, id) => file.counts[id];

// ── Six that must flag ──────────────────────────────────────────────────────

test("flags the importance heading verbatim", () => {
  const file = scan(
    "importance.md",
    "## Почему это важно\n\nБез этого новые правила не заработают.\n",
  );
  assert.equal(hits(file, "importance-para"), 1, "the heading is the pattern");
  assert.equal(
    hits(file, "empty-sentence"),
    1,
    "the line under it carries no fact, name, number or quotation",
  );
});

test("flags the revelation frame verbatim", () => {
  const file = scan("revelation.md", "это не просто X, это Y\n");
  assert.equal(hits(file, "revelation-frame"), 1);
});

test("flags the empty intensifier verbatim", () => {
  const file = scan("intensifier.md", "За это время правила во многом изменились.\n");
  assert.equal(hits(file, "empty-intensifier"), 1);
});

test("flags process narration of the tool", () => {
  const file = scan(
    "narration.md",
    "First I ran the scanner over the tree, then I read the table and compared the two counts.\n",
  );
  assert.equal(hits(file, "process-narration"), 1);
  assert.equal(
    hits(file, "long-sentence"),
    0,
    "the walkthrough is flagged for being a walkthrough, not for its length",
  );
});

test("flags the sentence whose actor was deleted", () => {
  const file = scan("actor.md", "Было принято решение переписать проверку.\n");
  assert.equal(hits(file, "deleted-actor"), 1);
});

test("flags a clause chain past thirty words and the metaphor inside it", () => {
  const file = scan(
    "chain.md",
    "The scanner is the backbone of the quality chain in this repository because it walks " +
      "over every tracked markdown file, counts each pattern hit per thousand words, prints " +
      "a table of the counts for whoever reads the run, and exits with zero in every case " +
      "unless its caller passes an explicit threshold that a later release may decide to " +
      "enforce.\n",
  );
  assert.ok(
    hits(file, "long-sentence") >= 1,
    "one sentence, well past the thirty-word line",
  );
  assert.equal(hits(file, "dead-metaphor"), 1);
});

// ── Six that must not flag ──────────────────────────────────────────────────

test("passes a changelog paragraph that carries its own facts", () => {
  const file = scan(
    "changelog.md",
    "- **`/vision-model` and `/max-power-model` are removed.** Both shipped with a one-release " +
      "warning and two have passed\n  since. Image analysis resolves through the current model when " +
      "it accepts images, else the merged role's first\n  image-capable entry, and `model-resolver` " +
      "no longer reads the vision key at all.\n",
  );
  assert.equal(file.sentences, 2, "a wrapped list item is two sentences, not three");
  assert.equal(hits(file, "importance-para"), 0);
  assert.equal(hits(file, "revelation-frame"), 0);
  assert.equal(hits(file, "empty-intensifier"), 0);
  assert.equal(hits(file, "process-narration"), 0);
  assert.equal(hits(file, "dead-metaphor"), 0);
  assert.equal(hits(file, "deleted-actor"), 0);
  assert.equal(hits(file, "long-sentence"), 0);
});

test("passes a code comment that explains a why", () => {
  const file = scan(
    "why.ts",
    "// The pool reuses the discarded file's TMPDIR: mkdtemp keeps it inside the case,\n" +
      "// so a failing helper cannot leak into the tree.\n",
  );
  assert.equal(hits(file, "long-sentence"), 0);
  assert.equal(hits(file, "empty-sentence"), 0, "TMPDIR is a name");
});

test("passes a short factual sentence with numbers", () => {
  const file = scan("facts.md", "The runner read 1092 files and exited 0.\n");
  assert.equal(hits(file, "empty-sentence"), 0);
  assert.equal(hits(file, "long-sentence"), 0);
});

test("passes a Russian ship-report sentence", () => {
  const file = scan(
    "ship-ru.md",
    "Проверка check-placement.mjs прошла: 0 нарушений на 1092 файлах.\n",
  );
  assert.equal(hits(file, "empty-sentence"), 0);
  assert.equal(hits(file, "deleted-actor"), 0);
});

test("passes an English ship-report sentence", () => {
  const file = scan("ship-en.md", "check-voice read 5 files and found 0 pattern hits.\n");
  assert.equal(hits(file, "process-narration"), 0, "the tool is the subject here by name");
  assert.equal(hits(file, "empty-sentence"), 0);
});

test("an empty file is zero rows, not a crash", () => {
  const file = scan("empty.md", "");
  assert.equal(file.words, 0);
  assert.equal(file.sentences, 0);
  assert.equal(file.meanSentenceLength, 0);
  for (const [id, count] of Object.entries(file.counts)) {
    assert.equal(count, 0, `${id} counts nothing in an empty file`);
  }
  const report = JSON.parse(
    execFileSync(process.execPath, [script, "--json", "--patterns"], {
      encoding: "utf-8",
    }),
  );
  assert.equal(report.patterns.length, 6, "the pattern table is data, six rows");
  for (const row of report.patterns) {
    assert.match(row.id, /^[a-z][a-z-]+$/);
    assert.ok(row.cost.length > 20, `${row.id} states what it costs the reader`);
  }
});
