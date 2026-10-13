/**
 * test-state-path-mirrors.mjs — the four braid-root mirrors must agree.
 *
 * core's `braidDir()`, providers' `braidDataRoot()`, telegram's `braidDir()`
 * and contrib's `braidDir()` are independent copies of one expression (each
 * package is standalone, so none may import another). Each was checked only
 * against its own literal, so drift between them was caught by nothing
 * executable.
 *
 * This probe runs all four in one child across every `BRAID_HOME` shape
 * (unset / absolute / absolute-but-missing / absolute-naming-a-file /
 * whitespace-padded absolute / `.` / relative / blank / whitespace / `~/braid`)
 * and every `HOME` shape (absolute / absolute-but-missing /
 * absolute-naming-a-file / whitespace-padded absolute / empty / `.` /
 * relative), and asserts:
 *   - all four resolve the SAME value for every variant, and
 *   - the refusal contract holds per package on every refusing variant: core
 *     THROWS and the three mirrors RETURN null (the child reports both the
 *     normalized value and the class, so a core that returned null where it
 *     must throw fails here rather than passing as agreement), and
 *   - the three absolute rarities behave as measured: a missing root and a
 *     root that names a file RESOLVE (nothing checks existence or file type -
 *     the writer that uses one is where that shows), while a whitespace-padded
 *     absolute is refused, since a padded path is not absolute as read, on
 *     either leg.
 *
 * All four are read as SOURCES (the child is spawned with
 * `--experimental-strip-types`), so a `dist/` left over from an earlier build
 * cannot mask drift in core's `src`: the comparison never touches a build
 * product. The tamper case below plants one-sided drift in copies of the four
 * sources and requires the probe to catch it, so the comparison is known to
 * be able to fail.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "../../..");
const CHILD = join(ROOT, "test", "helpers", "state-path-mirrors-child.mjs");

/** The four mirror sources, by package — read as sources, never from dist. */
const MIRRORS = {
  core: join(ROOT, "src", "lib", "config", "braid-paths.ts"),
  providers: join(ROOT, "..", "providers", "state-paths.ts"),
  telegram: join(ROOT, "..", "telegram", "src", "lib", "state-paths.ts"),
  contrib: join(ROOT, "..", "contrib", "state-paths.ts"),
};

const MIRROR_NAMES = ["core", "providers", "telegram", "contrib"];

/** HOME shapes that must be refused when BRAID_HOME is unset (the mirror of
 *  the override-leg list below: neither resolves an absolute root). */
const REFUSED_HOME = new Set([
  "empty",
  "dot",
  "relative",
  "whitespace-padded-absolute",
]);

/** BRAID_HOME shapes refused on the override leg. `blank` and `whitespace`
 *  are not here: both fall through to the HOME leg, exactly as core does. */
const REFUSED_BRAID = new Set(["dot", "relative", "tilde", "padded-absolute"]);

const FALLS_THROUGH = new Set(["unset", "blank", "whitespace"]);

/** Every variant the child must report, as the (rows) count: 7 HOME x 10
 *  BRAID_HOME. A shape silently dropped from the child would shrink this. */
const EXPECTED_ROWS = 7 * 10;

/** Run the child over one set of mirrors; returns its parsed JSON output. */
function runMirrors(mirrors, absHome) {
  const r = spawnSync(
    "node",
    [
      "--experimental-strip-types",
      CHILD,
      mirrors.core,
      mirrors.providers,
      mirrors.telegram,
      mirrors.contrib,
      absHome,
    ],
    { encoding: "utf8", timeout: 120_000 },
  );
  assert.equal(r.status, 0, `child exited ${r.status}: ${r.stderr}`);
  return JSON.parse((r.stdout ?? "").trim().split("\n").pop());
}

/** True when this variant must resolve a root rather than refuse one. */
function resolves(home, braid) {
  if (REFUSED_BRAID.has(braid)) return false;
  if (FALLS_THROUGH.has(braid)) return !REFUSED_HOME.has(home);
  return true;
}

/**
 * The matrix contract, asserted over one child run: every variant agrees on
 * the value, every refusing variant refuses in its own package's class (core
 * throws, the three mirrors return null), and the three absolute rarities
 * resolve or refuse exactly as measured. Extracted so the class plant below
 * can prove these assertions catch a core that returned null where it must
 * throw instead of trusting that they would.
 */
function assertMatrix(out) {
  assert.equal(
    out.rows.length,
    EXPECTED_ROWS,
    `expected the full ${EXPECTED_ROWS}-variant matrix, got ${out.rows.length}`,
  );
  assert.equal(out.homeVariants.length, 7, "seven HOME shapes");
  assert.equal(out.braidVariants.length, 10, "ten BRAID_HOME shapes");

  for (const row of out.rows) {
    const values = Object.values(row.cells);
    const unique = [...new Set(values)];
    assert.equal(
      unique.length,
      1,
      `${row.home}/${row.braid}: mirrors disagree: ${JSON.stringify(row.cells)}`,
    );

    // The class contract, per package: same value, and the refusal is thrown
    // by core and returned as null by the three mirrors. This is the half the
    // value comparison alone cannot see.
    if (!resolves(row.home, row.braid)) {
      assert.equal(
        row.cells.core,
        null,
        `${row.home}/${row.braid}: a refused variant resolves nothing`,
      );
      assert.equal(
        row.classes.core,
        "throw",
        `${row.home}/${row.braid}: core must refuse by throwing, got ${row.classes.core}`,
      );
      for (const name of MIRROR_NAMES.filter((n) => n !== "core")) {
        assert.equal(
          row.classes[name],
          "null",
          `${row.home}/${row.braid}: ${name} must refuse by returning null, got ${row.classes[name]}`,
        );
      }
    } else {
      for (const name of MIRROR_NAMES) {
        assert.equal(
          row.classes[name],
          "value",
          `${row.home}/${row.braid}: ${name} must resolve, got ${row.classes[name]}`,
        );
      }
    }
  }

  // The three absolute rarities, named: a missing root and a root that names a
  // file resolve to exactly that path (no existence or file-type check), and
  // the padded absolute is refused on either leg. Without these rows the only
  // pinned shapes are the ones the guard was written for.
  const rowOf = (home, braid) => out.rows.find((r) => r.home === home && r.braid === braid);
  const defaults = (home) => join(home, ".pi", "agent", "braid");
  const expectations = [
    ["absolute", "absolute-missing", out.shapes.absentBraid],
    ["absolute", "absolute-file", out.shapes.fileBraid],
    ["absolute-missing", "unset", defaults(out.shapes.absentHome)],
    ["absolute-file", "unset", defaults(out.shapes.fileHome)],
  ];
  for (const [home, braid, expected] of expectations) {
    const row = rowOf(home, braid);
    assert.ok(row, `${home}/${braid}: row must be in the matrix`);
    for (const name of MIRROR_NAMES) {
      assert.equal(
        row.cells[name],
        expected,
        `${home}/${braid}: ${name} must resolve the named path, got ${row.cells[name]}`,
      );
    }
  }
  for (const [home, braid] of [
    ["absolute", "padded-absolute"],
    ["whitespace-padded-absolute", "unset"],
  ]) {
    const row = rowOf(home, braid);
    assert.ok(row, `${home}/${braid}: row must be in the matrix`);
    assert.equal(
      row.classes.core,
      "throw",
      `${home}/${braid}: a padded absolute is not absolute as read and must be refused`,
    );
  }
}

test("the four braid-root mirrors agree on every HOME / BRAID_HOME shape", () => {
  // The comparison must stay over sources: a build product in one leg is what
  // let a drift in core's src go unseen.
  for (const [name, path] of Object.entries(MIRRORS)) {
    assert.ok(path.endsWith(".ts"), `${name}: expected a TypeScript source, got ${path}`);
    assert.ok(
      !path.includes(`${sep}dist${sep}`),
      `${name}: a build product is not a mirror: ${path}`,
    );
  }
  const absHome = mkdtempSync(join(tmpdir(), "mirror-home-"));
  try {
    assertMatrix(runMirrors(MIRRORS, absHome));
  } finally {
    rmSync(absHome, { recursive: true, force: true });
  }
});

test("a one-sided drift in any mirror copy is caught", () => {
  const absHome = mkdtempSync(join(tmpdir(), "mirror-home-"));
  const tree = mkdtempSync(join(tmpdir(), "mirror-tamper-"));
  try {
    // Copies, so the real tree is never touched. Each package's mirror is
    // self-contained (node builtins only), so a copy loads anywhere.
    const copies = {};
    for (const [name, path] of Object.entries(MIRRORS)) {
      const text = readFileSync(path, "utf8");
      const copy = join(tree, name, "state-paths.ts");
      mkdirSync(dirname(copy), { recursive: true });
      copies[name] = copy;
      writeFileSync(copy, text);
    }

    // Drift one copy: the same expression with a different braid directory.
    const drifted = readFileSync(copies.core, "utf8");
    const planted = drifted.replace('".pi", "agent", "braid"', '".pi", "agent", "braid-drift"');
    assert.notEqual(planted, drifted, "the drift plant found nothing to replace");
    writeFileSync(copies.core, planted);

    const out = runMirrors(copies, absHome);
    const disagreed = out.rows.filter((row) => new Set(Object.values(row.cells)).size !== 1);
    assert.ok(
      disagreed.length > 0,
      `a drifted core mirror must be caught, got agreement on all ${out.rows.length} rows`,
    );
  } finally {
    rmSync(absHome, { recursive: true, force: true });
    rmSync(tree, { recursive: true, force: true });
  }
});

test("a core that returns null where it must throw is caught by the class column", () => {
  // The class half of the contract, planted one-sided: a core copy whose
  // override leg RETURNS null instead of throwing agrees with the mirrors on
  // every value, so only the class assertion can see it. The plant runs
  // against the same assertMatrix the case above uses, so the net is proven
  // able to fail rather than assumed able.
  const absHome = mkdtempSync(join(tmpdir(), "mirror-home-"));
  const tree = mkdtempSync(join(tmpdir(), "mirror-class-"));
  try {
    const copies = {};
    for (const [name, path] of Object.entries(MIRRORS)) {
      const copy = join(tree, name, "state-paths.ts");
      mkdirSync(dirname(copy), { recursive: true });
      copies[name] = copy;
      writeFileSync(copy, readFileSync(path, "utf8"));
    }
    const source = readFileSync(copies.core, "utf8");
    const guardStart = source.indexOf("if (!path.isAbsolute(override)) {");
    const guardEnd = source.indexOf("return path.resolve(override);", guardStart);
    assert.ok(
      guardStart > 0 && guardEnd > guardStart,
      "the class plant found no override guard to replace",
    );
    const planted = `${source.slice(0, guardStart)}if (!path.isAbsolute(override)) {\n      return null as unknown as string;\n    }\n    ${source.slice(guardEnd)}`;
    writeFileSync(copies.core, planted);

    const out = runMirrors(copies, absHome);
    // The blind spot, stated: with the plant every value still agrees.
    for (const row of out.rows) {
      assert.equal(
        new Set(Object.values(row.cells)).size,
        1,
        `${row.home}/${row.braid}: the plant must keep every value in agreement, got ${JSON.stringify(row.cells)}`,
      );
    }
    const refusedRows = out.rows.filter((row) => !resolves(row.home, row.braid));
    assert.ok(refusedRows.length > 0, "the matrix must carry refusing variants");
    // Only the override leg is planted; the HOME leg's throw is untouched, so
    // the planted rows are exactly the refusing BRAID_HOME shapes.
    const plantedRows = refusedRows.filter((row) => REFUSED_BRAID.has(row.braid));
    assert.ok(plantedRows.length > 0, "the planted leg must carry refusing variants");
    assert.equal(
      plantedRows.filter((row) => row.classes.core !== "throw").length,
      plantedRows.length,
      "the plant must leave every refusing override variant's core class wrong",
    );
    assert.throws(
      () => assertMatrix(out),
      /core must refuse by throwing/,
      "the class column must catch the plant",
    );
  } finally {
    rmSync(absHome, { recursive: true, force: true });
    rmSync(tree, { recursive: true, force: true });
  }
});
