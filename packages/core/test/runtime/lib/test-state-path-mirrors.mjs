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
 * (unset / absolute / `.` / relative / blank / whitespace / `~/braid`) and
 * every `HOME` shape (absolute / empty / `.` / relative), and asserts:
 *   - all four resolve the SAME value for every variant, and
 *   - a relative or blank HOME (BRAID_HOME unset) is refused by all four
 *     (core throws, the mirrors return null).
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
    const out = runMirrors(MIRRORS, absHome);
    assert.ok(out.rows.length >= 28, `expected the full matrix, got ${out.rows.length}`);
    for (const row of out.rows) {
      const values = Object.values(row.cells);
      const unique = [...new Set(values)];
      assert.equal(
        unique.length,
        1,
        `${row.home}/${row.braid}: mirrors disagree: ${JSON.stringify(row.cells)}`,
      );
    }
    // A hostile HOME with no BRAID_HOME override must be refused by all four.
    for (const row of out.rows) {
      if (row.braid !== "unset") continue;
      if (row.home === "absolute") continue;
      for (const name of ["core", "providers", "telegram", "contrib"]) {
        assert.equal(
          row.cells[name],
          null,
          `${row.home}/unset: ${name} must refuse, got ${row.cells[name]}`,
        );
      }
    }
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
