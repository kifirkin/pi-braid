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
 * The child is spawned with `--experimental-strip-types` so the three TS
 * mirrors load as sources; core's mirror is imported from its built dist.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "../../..");
const CHILD = join(ROOT, "test", "helpers", "state-path-mirrors-child.mjs");

test("the four braid-root mirrors agree on every HOME / BRAID_HOME shape", () => {
  const absHome = mkdtempSync(join(tmpdir(), "mirror-home-"));
  try {
    const r = spawnSync(
      "node",
      [
        "--experimental-strip-types",
        CHILD,
        join(ROOT, "dist", "lib", "config", "braid-paths.js"),
        join(ROOT, "..", "providers", "state-paths.ts"),
        join(ROOT, "..", "telegram", "src", "lib", "state-paths.ts"),
        join(ROOT, "..", "contrib", "state-paths.ts"),
        absHome,
      ],
      { encoding: "utf8", timeout: 120_000 },
    );
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse((r.stdout ?? "").trim().split("\n").pop());
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
      assert.equal(
        row.cells.core,
        null,
        `${row.home}/unset: core must refuse, got ${row.cells.core}`,
      );
      assert.equal(
        row.cells.telegram,
        null,
        `${row.home}/unset: telegram must refuse, got ${row.cells.telegram}`,
      );
      assert.equal(
        row.cells.contrib,
        null,
        `${row.home}/unset: contrib must refuse, got ${row.cells.contrib}`,
      );
      assert.equal(
        row.cells.providers,
        null,
        `${row.home}/unset: providers must refuse, got ${row.cells.providers}`,
      );
    }
  } finally {
    rmSync(absHome, { recursive: true, force: true });
  }
});
