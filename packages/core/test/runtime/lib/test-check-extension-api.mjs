/**
 * test-check-extension-api.mjs — the extension-API guard catches dead
 * context calls and accepts declared context fields.
 *
 * Drive scripts/check-extension-api.mjs three ways:
 *   1. against the real tree (must stay clean — the live sweep),
 *   2. with a planted `ctx.getExtensionState` call (must flag it, exit 1),
 *   3. with a planted locally-declared context field (must allow it).
 *
 * The script scans the working tree, so the planted file is a real file
 * under src/ for the duration of the run and is removed in finally.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "../../..");
const SCRIPT = join(ROOT, "scripts", "check-extension-api.mjs");
const SRC_DIR = join(ROOT, "src");
const PLANT_DIR = join(SRC_DIR, "__guard_selftest__");
const PLANT_FILE = join(PLANT_DIR, "tmp-dead-call.ts");

function runScript(extraArgs = []) {
  return execFileSync("node", [SCRIPT, ...extraArgs], {
    cwd: ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

test("guard: real tree scans clean", () => {
  const out = runScript();
  assert.match(out, /✅ check-extension-api/);
  assert.match(out, /0 unclassified/);
  assert.match(out, /files, \d+ ctx accesses/);
});

test("guard: planted dead call is flagged and --strict exits 1", () => {
  mkdirSync(PLANT_DIR, { recursive: true });
  writeFileSync(
    PLANT_FILE,
    [
      "import type { ExtensionContext } from \"@earendil-works/pi-coding-agent\";",
      "",
      "export function deadCall(ctx: ExtensionContext): unknown {",
      "  return ctx.getExtensionState(\"some-key\");",
      "}",
      "",
    ].join("\n"),
  );
  try {
    assert.throws(
      () => runScript(["--strict"]),
      (err) => {
        const out = String(err.stdout ?? "") + String(err.stderr ?? "");
        assert.match(out, /❌ check-extension-api/);
        assert.match(out, /tmp-dead-call\.ts:4/);
        assert.match(out, /ctx\.getExtensionState/);
        assert.equal(err.status, 1);
        return true;
      },
    );
  } finally {
    rmSync(PLANT_DIR, { recursive: true, force: true });
  }
});

test("guard: a locally-declared context field is allowed", () => {
  mkdirSync(PLANT_DIR, { recursive: true });
  writeFileSync(
    PLANT_FILE,
    [
      "export interface SelfTestContext {",
      "  customLookup: (key: string) => unknown;",
      "}",
      "",
      "export function deadCall(ctx: SelfTestContext): unknown {",
      "  return ctx.customLookup(\"some-key\");",
      "}",
      "",
    ].join("\n"),
  );
  try {
    const out = runScript();
    assert.match(out, /✅ check-extension-api/);
  } finally {
    rmSync(PLANT_DIR, { recursive: true, force: true });
  }
});

test("guard: script self-consistency — declaredFields survives comment braces", () => {
  // Regression guard for the false-allow found during the first run: a doc
  // comment quoting a type cast must not declare fields.
  const src = readFileSync(SCRIPT, "utf8");
  assert.ok(/stripComments\(raw\)/.test(src), "field extraction must run on stripped text");
});
