/**
 * The ruler's gate: a fixture page with one planted defect of each kind, and a
 * clean control.
 *
 * The audit runs on recorded snapshots, not on a browser: the measurement is
 * the part that must be exact, and a browser in a test is a flake generator.
 * Every expected number below is derived from the snapshot with the test's own
 * arithmetic; none is copied from the audit's output. Coverage in particular is
 * recomputed from the recorded rects, because a check that shares the
 * instrument proves nothing.
 *
 * The clean control runs the same code and must print zero findings. A gate
 * that only ever sees failures cannot tell a working ruler from one that
 * reports everything.
 *
 * Run: node --experimental-strip-types --import ./test/lib/register-ts-resolve.mjs \
 *   test/design/fixture.test.mjs
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { createServer } from "node:net";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

register(new URL("../lib/ts-resolve.mjs", import.meta.url));

const HERE = dirname(fileURLToPath(import.meta.url));
const CONTRIB = join(HERE, "..", "..");
const DESIGN = join(CONTRIB, "design");

const { auditSnapshot, auditSnapshots } = await import(
  pathToFileURL(join(DESIGN, "audit.ts")).href
);
const { parseDesignTokens } = await import(
  pathToFileURL(join(DESIGN, "tokens.ts")).href
);
const { renderAudit } = await import(
  pathToFileURL(join(DESIGN, "render.ts")).href
);
const { waitForBrowser } = await import(
  pathToFileURL(join(DESIGN, "adapter.ts")).href
);

/**
 * A socket that accepts the connection and never answers: what Chrome looks
 * like while it holds the debugging port but has not started serving. The
 * readiness wait must fail on its own deadline rather than sit on the socket.
 */
test("the render path's readiness wait reports a silent browser, not a stall", async () => {
  const server = createServer(() => {});
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const port = server.address().port;
  const started = Date.now();
  try {
    await assert.rejects(
      () => waitForBrowser(port, 1200),
      new RegExp(`did not answer on port ${port} within 1200ms`),
    );
    const elapsed = Date.now() - started;
    assert.ok(
      elapsed < 5000,
      `the wait outlived its 1200ms deadline by ${elapsed}ms`,
    );
  } finally {
    server.close();
  }
});

const MUTED_PATH = "html > body:nth-of-type(1) > p:nth-of-type(1)";
const LABEL_PATH = "html > body:nth-of-type(1) > span:nth-of-type(1)";
const WIDE_PATH = "html > body:nth-of-type(1) > div:nth-of-type(4)";
const ICON_PATH = "html > body:nth-of-type(1) > button:nth-of-type(1)";

function loadFixture(name) {
  const directory = join(HERE, "fixtures", name);
  const byWidth = JSON.parse(
    readFileSync(join(directory, "snapshots.json"), "utf8"),
  );
  const snapshots = Object.values(byWidth).sort(
    (a, b) => a.viewportWidth - b.viewportWidth,
  );
  const tokens = parseDesignTokens(
    readFileSync(join(directory, "DESIGN.md"), "utf8"),
  );
  return { directory, byWidth, snapshots, tokens };
}

const defects = loadFixture("defects");
const clean = loadFixture("clean");
const defectsAudit = auditSnapshots(defects.snapshots, {
  designTokens: defects.tokens,
});
const cleanAudit = auditSnapshots(clean.snapshots, {
  designTokens: clean.tokens,
});

function widthOf(audit, width) {
  const found = audit.widths.find((entry) => entry.width === width);
  assert.ok(found, `audit has no ${width}px result`);
  return found;
}

function inventoryValues(widthAudit) {
  return [
    ...widthAudit.inventory.fontSizes,
    ...widthAudit.inventory.fontWeights,
    ...widthAudit.inventory.lineHeights,
    ...widthAudit.inventory.spacings,
    ...widthAudit.inventory.radii,
    ...widthAudit.inventory.shadows,
  ];
}

/** A node's painted area, clipped to the page, with the test's own arithmetic. */
function boxArea(node, snapshot) {
  const x0 = Math.max(0, node.rect.x);
  const x1 = Math.min(snapshot.viewportWidth, node.rect.x + node.rect.width);
  const y0 = Math.max(0, node.rect.y);
  const y1 = Math.min(snapshot.documentHeight, node.rect.y + node.rect.height);
  return Math.max(0, x1 - x0) * Math.max(0, y1 - y0);
}

function paintedArea(snapshot, predicate) {
  return snapshot.nodes
    .filter(predicate)
    .reduce((sum, node) => sum + boxArea(node, snapshot), 0);
}

test("defect fixture at 320: the planted contrast pair is the only failure", () => {
  const measured = widthOf(defectsAudit, 320);
  assert.equal(measured.contrast.checked, 6, "six text-bearing elements");
  assert.equal(measured.contrast.skipped, 0);
  assert.equal(
    measured.contrast.failures.length,
    1,
    "exactly one failing pair",
  );

  const [failure] = measured.contrast.failures;
  assert.equal(failure.path, MUTED_PATH);
  assert.equal(failure.foreground, "#999999");
  assert.equal(failure.background, "#ffffff");
  assert.equal(failure.ratio, 2.85);
  assert.equal(failure.required, 4.5, "16px regular text needs AA");
  assert.equal(failure.fontSizePx, 16);
  assert.equal(failure.fontWeight, 400);
});

test("defect fixture at 320: one off-grid font size, named", () => {
  const measured = widthOf(defectsAudit, 320);
  const sizes = measured.inventory.fontSizes;
  assert.deepEqual(
    sizes.map((use) => use.value),
    ["13px", "16px"],
  );
  const offGrid = sizes.filter((use) => use.onGrid === false);
  assert.equal(offGrid.length, 1);
  assert.equal(offGrid[0].value, "13px");
  assert.equal(offGrid[0].count, 1);
  for (const use of measured.inventory.spacings) {
    assert.equal(
      use.onGrid,
      true,
      `spacing ${use.value} should be on the 4px grid`,
    );
  }
});

test("defect fixture at 320: seven radii and three shadows, counted exactly", () => {
  const measured = widthOf(defectsAudit, 320);
  assert.deepEqual(
    measured.inventory.radii.map((use) => use.value),
    ["1px", "2px", "3px", "4px", "5px", "6px", "7px"],
  );
  assert.equal(measured.inventory.radii.length, 7);
  assert.equal(measured.inventory.shadows.length, 3);
});

test("defect fixture at 320: one sub-44px tap target, named", () => {
  const measured = widthOf(defectsAudit, 320);
  assert.equal(measured.tapTargets.length, 1);
  assert.deepEqual(measured.tapTargets[0], {
    path: ICON_PATH,
    width: 20,
    height: 20,
  });
});

test("defect fixture: one overflow at 320, none at 390, 768 or 1440", () => {
  const narrow = widthOf(defectsAudit, 320);
  assert.equal(narrow.overflow.length, 1);
  assert.equal(narrow.overflow[0].path, WIDE_PATH);
  assert.equal(narrow.overflow[0].reason, "viewport");
  assert.equal(narrow.overflow[0].right, 380);

  for (const width of [390, 768, 1440]) {
    assert.equal(
      widthOf(defectsAudit, width).overflow.length,
      0,
      `no overflow at ${width}px`,
    );
  }
});

test("defect fixture: colour coverage matches the recorded boxes and sums to 100", () => {
  const snapshot = defects.byWidth["320"];
  const measured = widthOf(defectsAudit, 320);
  const pageArea = snapshot.viewportWidth * snapshot.documentHeight;

  const expected = new Map([
    [
      "#f0f0f0",
      paintedArea(
        snapshot,
        (node) => node.style.backgroundColor === "rgb(240, 240, 240)",
      ),
    ],
    [
      "#e0e0e0",
      paintedArea(
        snapshot,
        (node) => node.style.backgroundColor === "rgb(224, 224, 224)",
      ),
    ],
    [
      "#eeeeee",
      paintedArea(
        snapshot,
        (node) => node.style.backgroundColor === "rgb(238, 238, 238)",
      ),
    ],
  ]);
  const painted = [...expected.values()].reduce((sum, area) => sum + area, 0);
  expected.set("#ffffff", pageArea - painted);

  assert.equal(measured.colors.length, expected.size);
  for (const color of measured.colors) {
    const area = expected.get(color.value);
    assert.ok(area !== undefined, `unexpected colour ${color.value}`);
    assert.ok(
      Math.abs(color.area - area) < 0.01,
      `${color.value}: audit area ${color.area} != box area ${area}`,
    );
    assert.ok(
      Math.abs(color.coverage - (area / pageArea) * 100) < 0.011,
      `${color.value}: coverage ${color.coverage}% != ${((area / pageArea) * 100).toFixed(2)}%`,
    );
  }
  assert.equal(measured.coverageTotal, 100);
});

test("defect fixture: one token hit and four token misses", () => {
  const measured = widthOf(defectsAudit, 320);
  const values = inventoryValues(measured);
  const hits = values.filter((use) => use.inTokens === true);
  const misses = values.filter((use) => use.inTokens === false);

  assert.equal(
    defects.tokens.tokenCount,
    5,
    "the fixture token file has five tokens",
  );
  assert.deepEqual(
    hits.map((use) => use.value),
    ["16px"],
  );
  assert.deepEqual(misses.map((use) => use.value).sort(), [
    "13px",
    "24px",
    "4px",
    "8px",
  ]);
});

test("defect fixture: the audit-level finding count is the 320px count", () => {
  const measured = widthOf(defectsAudit, 320);
  assert.deepEqual(measured.findings, {
    contrast: 1,
    offGrid: 1,
    missingTokens: 4,
    tapTargets: 1,
    overflow: 1,
    total: 8,
  });
  assert.deepEqual(defectsAudit.findings, { width: 320, ...measured.findings });
});

test("clean-page control reports zero findings at every width", () => {
  for (const width of cleanAudit.widths) {
    assert.deepEqual(
      width.findings,
      {
        contrast: 0,
        offGrid: 0,
        missingTokens: 0,
        tapTargets: 0,
        overflow: 0,
        total: 0,
      },
      `${width.width}px is not clean`,
    );
    assert.equal(width.contrast.failures.length, 0);
    assert.equal(width.tapTargets.length, 0);
    assert.equal(width.overflow.length, 0);
    assert.equal(
      inventoryValues(width).filter(
        (use) => use.onGrid === false || use.inTokens === false,
      ).length,
      0,
    );
  }
  assert.equal(cleanAudit.findings.total, 0);
});

test("determinism: two runs on the same snapshots are byte-identical", () => {
  const first = auditSnapshots(defects.snapshots, {
    designTokens: defects.tokens,
  });
  const second = auditSnapshots(defects.snapshots, {
    designTokens: parseDesignTokens(
      readFileSync(join(defects.directory, "DESIGN.md"), "utf8"),
    ),
  });
  assert.equal(JSON.stringify(first), JSON.stringify(second));

  const snapshot = defects.byWidth["320"];
  assert.equal(
    JSON.stringify(auditSnapshot(snapshot, { designTokens: defects.tokens })),
    JSON.stringify(auditSnapshot(snapshot, { designTokens: defects.tokens })),
  );

  const rendered = renderAudit(first);
  assert.equal(rendered, renderAudit(second));
  assert.match(
    rendered,
    /Verdict at the narrowest width \(320px\): 8 findings\./,
  );
});

test("a malformed snapshot is refused, not measured", () => {
  const broken = JSON.parse(JSON.stringify(defects.byWidth["320"]));
  broken.nodes[2].parent = broken.nodes.length;
  assert.throws(
    () => auditSnapshot(broken),
    /not an earlier node/,
    "a parent that is not an earlier node must be refused",
  );
});

test("registration: the extension registers both tools and honors its off switch", async () => {
  const { default: designExtension } = await import(
    pathToFileURL(join(DESIGN, "index.ts")).href
  );
  const calls = [];
  const api = {
    registerTool: (tool) => calls.push(tool),
    registerCommand: () => {},
    on: () => {},
    getAllTools: () => [],
    getActiveTools: () => [],
    setActiveTools: () => {},
  };

  const savedHome = process.env.HOME;
  const savedAgentDir = process.env.PI_CODING_AGENT_DIR;
  const disabledHome = mkdtempSync(join(tmpdir(), "design-toggle-off-"));
  const enabledHome = mkdtempSync(join(tmpdir(), "design-toggle-on-"));
  try {
    writeFileSync(
      join(disabledHome, "settings.json"),
      JSON.stringify({ braid: { contrib: { design: false } } }),
    );
    process.env.HOME = disabledHome;
    process.env.PI_CODING_AGENT_DIR = disabledHome;
    designExtension(api);
    assert.equal(calls.length, 0, "design: false must register nothing");

    writeFileSync(join(enabledHome, "settings.json"), "{}");
    process.env.HOME = enabledHome;
    process.env.PI_CODING_AGENT_DIR = enabledHome;
    designExtension(api);
    assert.deepEqual(
      calls.map((tool) => tool.name),
      ["design_audit", "design_board"],
    );
  } finally {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    if (savedAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = savedAgentDir;
    rmSync(disabledHome, { recursive: true, force: true });
    rmSync(enabledHome, { recursive: true, force: true });
  }
});

test("the label is text-bearing and measured, not skipped", () => {
  const measured = widthOf(defectsAudit, 320);
  const label = defects.byWidth["320"].nodes.find(
    (node) => node.path === LABEL_PATH,
  );
  assert.ok(label);
  assert.equal(label.text, "Thirteen pixel label");
  assert.equal(measured.inventory.fontSizes[0].count, 1);
});
