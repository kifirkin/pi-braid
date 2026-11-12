/**
 * The board's gate: five arms over recorded snapshots, no browser.
 *
 *   1. one self-contained page names every variant and every width, carries
 *      the record's digest, and reaches the network for nothing;
 *   2. the marked cells hold the best value in their column, and a column with
 *      no better direction is left unmarked;
 *   3. a decision renders, an undecided board says so, and a decision that
 *      names no variant on the board is refused;
 *   4. `--check` is clean on an unchanged board, fails on a stale page before
 *      it renders anything, and names the variant and the metric when a
 *      passing ratio is planted weaker;
 *   5. the control: one variant is one row with no invented winner.
 *
 * Every number the arms expect is derived here, from the same snapshots the
 * board reads: the per-width counts come from the ruler, and the aggregation
 * (worst width, least ratio) is recomputed in the test. The fixture also
 * asserts what it *is* (rail has no failing pair, stacked has no overflow), so
 * an arm cannot pass because the fixture quietly changed.
 *
 * Run: node --experimental-strip-types --import ./test/lib/register-ts-resolve.mjs \
 *   test/design/board.test.mjs
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

register(new URL("../lib/ts-resolve.mjs", import.meta.url));

const HERE = dirname(fileURLToPath(import.meta.url));
const CONTRIB = join(HERE, "..", "..");
const DESIGN = join(CONTRIB, "design");
const FIXTURE_DIR = join(HERE, "fixtures", "board");

const { composeBoard, manifestDigest, renderBoardSummary } = await import(
  pathToFileURL(join(DESIGN, "board.ts")).href
);
const { checkBoard } = await import(
  pathToFileURL(join(DESIGN, "board-run.ts")).href
);
const { auditSnapshot } = await import(
  pathToFileURL(join(DESIGN, "audit.ts")).href
);

const RECORDED = JSON.parse(
  readFileSync(join(FIXTURE_DIR, "snapshots.json"), "utf8"),
);
const NAMES = ["stacked", "rail", "sheet"];
const WIDTHS = [320, 390];
const VERSION = JSON.parse(
  readFileSync(join(CONTRIB, "package.json"), "utf8"),
).version;

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function snapshotsFor(name, recorded = RECORDED) {
  return Object.values(recorded[name]).sort(
    (a, b) => a.viewportWidth - b.viewportWidth,
  );
}

function variantsFrom(recorded = RECORDED) {
  return NAMES.map((name) => ({
    name,
    source: `test/design/fixtures/board/${name}.html`,
    sourceKind: "file",
    snapshots: snapshotsFor(name, recorded),
  }));
}

function composeBoardFor(options = {}) {
  return composeBoard({
    variants: options.variants ?? variantsFrom(options.recorded),
    widths: options.widths ?? WIDTHS,
    decision: options.decision ?? null,
    toolVersion: options.toolVersion ?? VERSION,
    title: options.title ?? "Feed, one ad",
    shots: options.shots ?? [],
  });
}

function audited(recorded = RECORDED) {
  const audit = {};
  for (const name of NAMES) {
    audit[name] = snapshotsFor(name, recorded).map((snapshot) =>
      auditSnapshot(snapshot),
    );
  }
  return audit;
}

function countValues(audit) {
  const inventory = audit.inventory;
  return [
    inventory.fontSizes,
    inventory.fontWeights,
    inventory.lineHeights,
    inventory.spacings,
    inventory.radii,
    inventory.shadows,
  ].reduce((sum, family) => sum + family.length, 0);
}

function worst(values) {
  return Math.max(...values.filter((value) => value !== null));
}

function least(values) {
  return Math.min(...values.filter((value) => value !== null));
}

function decode(text) {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&");
}

function textOf(html) {
  return decode(html.replace(/<[^>]*>/g, ""))
    .replace(/\s+/g, " ")
    .trim();
}

/** The comparison table's rows, each cell carrying its text and best flag. */
function comparisonCells(html) {
  const section = html.split("<h2>Comparison</h2>")[1];
  assert.ok(section, "the page has no comparison section");
  const table = section.split("</table>")[0];
  const rows = [];
  for (const match of table.matchAll(/<tr>([\s\S]*?)<\/tr>/g)) {
    const cells = [
      ...match[1].matchAll(/<(t[dh])\b([^>]*)>([\s\S]*?)<\/\1>/g),
    ].map((cell) => ({
      tag: cell[1],
      header: cell[1] === "th",
      best: /\bbest\b/.test(cell[2]),
      text: textOf(cell[3]),
    }));
    if (cells.length > 0) rows.push(cells);
  }
  return rows;
}

/** The variant names whose cell in `label`'s column is marked best. */
function markedNames(html, label) {
  const rows = comparisonCells(html);
  const header = rows[0];
  const column = header.findIndex((cell) => cell.text.startsWith(label));
  assert.ok(
    column > 0,
    `no column labelled ${label} in: ${header.map((cell) => cell.text).join(" | ")}`,
  );
  return rows
    .slice(1)
    .filter((row) => row[column].best)
    .map((row) => row[0].text);
}

function cellValue(html, name, label) {
  const rows = comparisonCells(html);
  const header = rows[0];
  const column = header.findIndex((cell) => cell.text.startsWith(label));
  const row = rows.find((candidate) => candidate[0].text === name);
  assert.ok(row, `no row for ${name}`);
  return row[column].text.replace(/\s*best$/, "");
}

const board = composeBoardFor();
const measurements = audited();

test("arm 1: one self-contained page names every variant and every width", () => {
  assert.match(board.html, /^<!doctype html>/);
  assert.match(board.html, /<html lang="en">/);
  assert.equal(board.manifest.variants.length, 3);
  assert.deepEqual(board.manifest.widths, [320, 390]);

  for (const name of NAMES) {
    assert.ok(
      board.html.includes(`>${name}</`),
      `the page does not name the variant ${name}`,
    );
    for (const width of WIDTHS) {
      assert.ok(
        board.html.includes(`<th scope="row">${width}px</th>`),
        `${name} has no ${width}px row on the page`,
      );
    }
  }

  // The ruler's numbers travel under each shot, not only in the table.
  const rail = measurements.rail[0];
  assert.ok(
    board.html.includes(
      `${rail.contrast.failures.length}/${rail.contrast.checked} failing`,
    ),
    "the numbers under a shot are not the ruler's",
  );
  assert.ok(board.html.includes(`weakest ${rail.contrast.smallest}`));

  // Self-contained: no script, no stylesheet link, no network reference.
  assert.ok(!/<script/i.test(board.html), "the page carries a script");
  assert.ok(!/<link/i.test(board.html), "the page links an asset");
  assert.ok(
    !/https?:\/\//.test(board.html),
    "the page reaches the network: a URL appears in it",
  );
  assert.ok(
    !/@import|url\(\s*['"]?https?:/i.test(board.html),
    "the page imports a remote style",
  );

  // The page and the record name each other.
  assert.ok(board.html.includes(board.manifest.pageDigest));
  assert.equal(manifestDigest(board.manifest), board.manifest.pageDigest);
  assert.deepEqual(JSON.parse(JSON.stringify(board.manifest)), board.manifest);

  // Markup in a name is escaped, never rendered.
  const escaped = composeBoardFor({ title: 'Feed <one> & "only"' });
  assert.ok(escaped.html.includes("Feed &lt;one&gt; &amp; &quot;only&quot;"));
  assert.ok(!escaped.html.includes("<one>"));

  // A supplied screenshot is embedded once, and only where it was supplied.
  const withShot = composeBoardFor({
    shots: [{ name: "rail", width: 320, data: "AAAA", height: 900 }],
  });
  assert.equal(
    (withShot.html.match(/data:image\/png;base64,/g) ?? []).length,
    1,
  );
  assert.match(withShot.html, /data:image\/png;base64,AAAA/);
  assert.match(withShot.html, /no screenshot recorded at 390px/);
});

test("arm 2: the marked cells hold the best value in their column", () => {
  // What the fixture is, so an arm cannot pass on a fixture that moved.
  for (const name of ["rail"]) {
    for (const audit of measurements[name]) {
      assert.equal(audit.contrast.failures.length, 0, `${name} fails contrast`);
    }
  }
  for (const name of ["stacked", "sheet"]) {
    assert.ok(
      measurements[name].every((audit) => audit.contrast.failures.length > 0),
      `${name} no longer carries a failing pair`,
    );
  }
  assert.ok(
    measurements.stacked.every((audit) => audit.overflow.length === 0),
    "stacked is supposed to be the variant without overflow",
  );
  const overflowCounts = Object.fromEntries(
    NAMES.map((name) => [
      name,
      worst(measurements[name].map((audit) => audit.overflow.length)),
    ]),
  );
  assert.equal(overflowCounts.stacked, 0);
  assert.ok(
    overflowCounts.rail > overflowCounts.sheet &&
      overflowCounts.rail > overflowCounts.stacked,
    `rail is supposed to have the worst overflow, got ${JSON.stringify(overflowCounts)}`,
  );

  // The aggregate is the worst width (or the least ratio), recomputed here.
  for (const name of NAMES) {
    const record = board.manifest.variants.find(
      (variant) => variant.name === name,
    );
    const audits = measurements[name];
    assert.equal(
      record.aggregate.contrastFailures,
      worst(audits.map((audit) => audit.contrast.failures.length)),
      `${name}: contrast failures are not the worst width`,
    );
    assert.equal(
      record.aggregate.worstRatio,
      least(audits.map((audit) => audit.contrast.smallest)),
      `${name}: the weakest ratio is not the least`,
    );
    assert.equal(
      record.aggregate.tapTargets,
      worst(audits.map((audit) => audit.tapTargets.length)),
    );
    assert.equal(
      record.aggregate.overflow,
      worst(audits.map((audit) => audit.overflow.length)),
    );
    assert.equal(
      record.aggregate.distinctValues,
      worst(audits.map(countValues)),
    );
    assert.equal(
      record.aggregate.palette,
      worst(audits.map((audit) => audit.colors.length)),
    );
  }

  // Rail has the best contrast and the worst overflow; the marks say exactly
  // that, and a tie is marked on every tying cell.
  assert.deepEqual(markedNames(board.html, "contrast failures"), ["rail"]);
  assert.deepEqual(markedNames(board.html, "overflow"), ["stacked"]);
  assert.deepEqual(markedNames(board.html, "tap targets"), ["rail", "sheet"]);
  assert.deepEqual(markedNames(board.html, "distinct values"), ["rail"]);
  assert.deepEqual(markedNames(board.html, "dominant colour"), []);

  // A cell's text is the aggregate the record carries.
  const railRecord = board.manifest.variants.find(
    (variant) => variant.name === "rail",
  );
  assert.equal(
    cellValue(board.html, "rail", "contrast failures"),
    String(railRecord.aggregate.contrastFailures),
  );
  assert.equal(
    cellValue(board.html, "rail", "weakest ratio"),
    railRecord.aggregate.worstRatio.toFixed(2),
  );

  // The tool's own text marks the same cells as the page.
  const summary = renderBoardSummary(board.manifest);
  const railLine = summary
    .split("\n")
    .find((line) => line.startsWith("| rail |"));
  assert.ok(railLine.includes("| **0** |"), railLine);
  const stackedLine = summary
    .split("\n")
    .find((line) => line.startsWith("| stacked |"));
  assert.ok(stackedLine.includes("| **0** |"), stackedLine);
});

test("arm 3: a decision renders, an open board says so, a bad decision is refused", () => {
  assert.equal(board.manifest.decision, null);
  assert.ok(textOf(board.html).includes("Undecided"));

  const reason =
    "Rail: no failing pair at either width, the fewest distinct values, and the narrowest palette.";
  const decided = composeBoardFor({
    decision: { variant: "rail", reason },
  });
  assert.deepEqual(decided.manifest.decision, { variant: "rail", reason });
  const pageText = textOf(decided.html);
  assert.ok(pageText.includes("Decision: rail"), pageText.slice(0, 400));
  assert.ok(pageText.includes(reason));
  assert.ok(!pageText.includes("Undecided"));
  assert.ok(
    renderBoardSummary(decided.manifest).includes(
      `Decision: **rail** — ${reason}`,
    ),
  );
  assert.ok(decided.html.includes(decided.manifest.pageDigest));
  assert.notEqual(decided.manifest.pageDigest, board.manifest.pageDigest);

  assert.throws(
    () => composeBoardFor({ decision: { variant: "ghost", reason } }),
    /ghost/,
    "a decision naming a variant the board does not carry must be refused",
  );
  assert.throws(
    () => composeBoardFor({ decision: { variant: "rail", reason: "   " } }),
    /reason/,
    "a decision without a reason must be refused",
  );
  assert.throws(
    () => composeBoardFor({ decision: { reason } }),
    /variant/,
    "a decision without a variant name must be refused",
  );
});

function measuredFrom(recorded, sources) {
  return sources.map((source) => ({
    source: {
      name: source.name,
      source: source.source,
      sourceKind: source.sourceKind,
    },
    snapshots: snapshotsFor(source.name, recorded),
    shots: [],
  }));
}

function writeBoard(directory, composed) {
  writeFileSync(
    join(directory, "board.json"),
    `${JSON.stringify(composed.manifest, null, 2)}\n`,
  );
  writeFileSync(join(directory, "board.html"), composed.html);
}

test("arm 4: --check is clean, fails before rendering on a stale page, and names what moved", async () => {
  const directory = mkdtempSync(join(tmpdir(), "design-board-"));
  try {
    writeBoard(directory, board);
    let measured = 0;
    const clean = await checkBoard(join(directory, "board.json"), {
      measure: async (sources) => {
        measured += 1;
        return measuredFrom(RECORDED, sources);
      },
    });
    assert.equal(clean.exitCode, 0, clean.text);
    assert.deepEqual(clean.drift, []);
    assert.match(clean.text, /No number moved\. Verdict: clean\./);
    assert.equal(measured, 1);

    // A record whose variants cannot be rendered is exit 2: the check did not
    // run, which is different from the numbers having moved.
    const unmeasurable = await checkBoard(join(directory, "board.json"), {
      measure: async () => {
        throw new Error("no such page");
      },
    });
    assert.equal(unmeasurable.exitCode, 2, unmeasurable.text);
    assert.match(
      unmeasurable.text,
      /could not measure the record's variants: no such page/,
    );

    // A page that does not carry the record's digest: no browser is touched.
    writeFileSync(
      join(directory, "board.html"),
      "<!doctype html><p>older page</p>",
    );
    let rendered = 0;
    const stale = await checkBoard(join(directory, "board.json"), {
      measure: async () => {
        rendered += 1;
        return [];
      },
    });
    assert.equal(stale.exitCode, 1);
    assert.ok(
      stale.drift.some((entry) => entry.kind === "page"),
      `no page drift: ${stale.text}`,
    );
    assert.equal(rendered, 0, "a stale page must fail before anything renders");

    // The page is restored; the edit goes into the measured page instead: the
    // meta line's colour becomes a weaker grey that still passes WCAG AA.
    writeBoard(directory, board);
    const planted = clone(RECORDED);
    for (const width of WIDTHS) {
      const nodes = planted.rail[String(width)].nodes;
      const at = nodes.findIndex(
        (node) => node.text === "3 km · verified · 2h 14m left",
      );
      assert.ok(at >= 0, `the meta line moved at ${width}px`);
      assert.equal(nodes[at].style.color, "rgb(168, 163, 180)");
      nodes[at].style.color = "rgb(139, 134, 152)";
    }

    const plantedAudit = auditSnapshot(planted.rail["320"]);
    assert.equal(
      plantedAudit.contrast.failures.length,
      0,
      "the planted colour must still pass, or the arm proves nothing about a passing pair",
    );
    assert.ok(
      plantedAudit.contrast.smallest < measurements.rail[0].contrast.smallest,
    );

    const drifted = await checkBoard(join(directory, "board.json"), {
      measure: async (sources) => measuredFrom(planted, sources),
    });
    assert.equal(drifted.exitCode, 1);
    const named = drifted.drift.filter((entry) => entry.kind === "metric");
    assert.ok(named.length > 0, `no metric drift: ${drifted.text}`);
    const ratio = named.find((entry) => entry.metric === "worstRatio");
    assert.ok(ratio, `no weakest-ratio drift: ${drifted.text}`);
    assert.equal(ratio.variant, "rail");
    assert.equal(
      ratio.recorded,
      least(measurements.rail.map((audit) => audit.contrast.smallest)),
    );
    assert.equal(ratio.fresh, plantedAudit.contrast.smallest);
    assert.match(
      drifted.text,
      /variant "rail": weakest ratio moved 5\.34 → 5\.11/,
      drifted.text,
    );

    // The real process: the stale-page path exits non-zero without a browser.
    rmSync(join(directory, "board.html"));
    const cli = spawnSync(
      process.execPath,
      [
        "--experimental-strip-types",
        "--import",
        join(CONTRIB, "test", "lib", "register-ts-resolve.mjs"),
        join(DESIGN, "board-run.ts"),
        "--check",
        directory,
      ],
      { cwd: CONTRIB, encoding: "utf8" },
    );
    assert.equal(cli.status, 1, `${cli.stdout}\n${cli.stderr}`);
    assert.match(cli.stdout, /DRIFT/);
    assert.match(cli.stdout, /the page moved|the page/);

    // A record that cannot be read is a different failure: exit 2.
    const absent = spawnSync(
      process.execPath,
      [
        "--experimental-strip-types",
        "--import",
        join(CONTRIB, "test", "lib", "register-ts-resolve.mjs"),
        join(DESIGN, "board-run.ts"),
        "--check",
        join(directory, "no-such-board.json"),
      ],
      { cwd: CONTRIB, encoding: "utf8" },
    );
    assert.equal(absent.status, 2, `${absent.stdout}\n${absent.stderr}`);
    assert.match(absent.stdout, /no board record/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("arm 5: control — one variant is one row, no invented best, bounded output", () => {
  const shots = WIDTHS.map((width) => ({
    name: "rail",
    width,
    data: "A".repeat(20000),
    height: 900,
  }));
  const single = composeBoardFor({
    variants: variantsFrom().filter((variant) => variant.name === "rail"),
    shots,
  });

  assert.equal(single.table.rows.length, 1);
  assert.equal(single.table.marks, false);
  assert.match(single.table.note, /One variant/);
  for (const cell of single.table.rows[0].cells) {
    assert.equal(
      cell.best,
      false,
      `${cell.metric} was marked on a board of one`,
    );
  }

  const rows = comparisonCells(single.html);
  assert.equal(rows.length, 2, "a control board is a header and one row");
  assert.ok(
    !/class="[^"]*\bbest\b/.test(single.html),
    "the page marks a best cell on a board of one",
  );
  assert.match(textOf(single.html), /One variant/);

  // The row still prints what was measured.
  const record = single.manifest.variants[0];
  assert.equal(
    cellValue(single.html, "rail", "contrast failures"),
    String(record.aggregate.contrastFailures),
  );

  // Bounded: one image per measured width, and the record carries no pixels.
  assert.equal(
    (single.html.match(/data:image\/png;base64,/g) ?? []).length,
    WIDTHS.length,
  );
  assert.ok(!JSON.stringify(single.manifest).includes("AAAAAAAA"));
  assert.ok(renderBoardSummary(single.manifest).length < 4000);
});
