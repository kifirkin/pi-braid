// test-check-global-slots.mjs - the checker refuses, permits, and exempts.
//
// WHY THIS FILE EXISTS:
//   A checker that cannot fail is a green light with no wire. These cases drive
//   check-global-slots.mjs over synthetic trees built in a temp directory: an
//   unregistered key must be refused by name, the same key must pass once it
//   is in the legacy set, a `defineSlot` descriptor must permit its own key,
//   and the mechanism file must be exempt rather than silently skipped.
//
// THE LAST CASE IS THE REAL TREE:
//   The rule is about this repository, so the fixture also runs the checker on
//   the checkout it lives in. A synthetic-only suite would pass over a tree
//   full of undeclared slots.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const CHECKER = join(
  import.meta.dirname,
  "..",
  "..",
  "..",
  "scripts",
  "check-global-slots.mjs",
);

const REGISTRY_PATH = "packages/core/src/lib/state/slot-registry.ts";

function registrySource(keys) {
  const rows = keys
    .map((key) => `  { key: "${key}", file: "fixture", reason: "fixture entry" },`)
    .join("\n");
  return `export const LEGACY_GLOBAL_SLOTS = [\n${rows}\n];\n`;
}

function castSource(key, extra = "") {
  return [
    `export function read(): unknown {`,
    `  return (globalThis as Record<string, unknown>)["${key}"];`,
    `}`,
    extra,
    "",
  ].join("\n");
}

function buildTree(files) {
  const root = mkdtempSync(join(tmpdir(), "global-slots-check-"));
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), body, "utf8");
  }
  return root;
}

function runChecker(root) {
  return spawnSync(process.execPath, [CHECKER, "--root", root], {
    encoding: "utf8",
  });
}

test("an unregistered slot is refused, naming the key and the file", () => {
  const root = buildTree({
    [REGISTRY_PATH]: registrySource(["__braid_fixture_legacy"]),
    "packages/core/src/app/new-slot.ts": castSource("__braid_fixture_unregistered"),
  });
  try {
    const run = runChecker(root);
    assert.equal(run.status, 1, `expected a refusal, got: ${run.stdout}${run.stderr}`);
    assert.match(run.stderr, /__braid_fixture_unregistered/);
    assert.match(run.stderr, /packages\/core\/src\/app\/new-slot\.ts/);
    assert.match(run.stderr, /not declared by defineSlot\(\)/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the same file passes once the key is in the legacy set", () => {
  const root = buildTree({
    [REGISTRY_PATH]: registrySource([
      "__braid_fixture_legacy",
      "__braid_fixture_unregistered",
    ]),
    "packages/core/src/app/new-slot.ts": castSource("__braid_fixture_unregistered"),
  });
  try {
    const run = runChecker(root);
    assert.equal(run.status, 0, `expected a pass, got: ${run.stdout}${run.stderr}`);
    assert.match(run.stdout, /Global slot check\.\.\. PASS/);
    assert.match(run.stdout, /2 legacy key\(s\) declared with reasons/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a defineSlot descriptor permits its own key", () => {
  const root = buildTree({
    [REGISTRY_PATH]: registrySource(["__braid_fixture_legacy"]),
    "packages/core/src/app/declared.ts": [
      `import { defineSlot } from "../state/slot.js";`,
      `const slot = defineSlot({`,
      `  key: "__braid_fixture_declared",`,
      `  version: 1,`,
      `  owner: "fixture",`,
      `  parse: (value: unknown) => value,`,
      `});`,
      `export const KEY = slot.key;`,
      `export function legacy(): unknown {`,
      `  return (globalThis as Record<string, unknown>)["__braid_fixture_legacy"];`,
      `}`,
      "",
    ].join("\n"),
  });
  try {
    const run = runChecker(root);
    assert.equal(run.status, 0, `expected a pass, got: ${run.stdout}${run.stderr}`);
    assert.match(run.stdout, /1 slot key\(s\) declared by defineSlot\(\)/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the mechanism file is exempt by path, and the exemption is printed", () => {
  const root = buildTree({
    [REGISTRY_PATH]: registrySource(["__braid_fixture_legacy"]),
    "packages/core/src/lib/state/slot.ts": castSource("__braid_anything"),
  });
  try {
    const run = runChecker(root);
    assert.equal(run.status, 0, `expected a pass, got: ${run.stdout}${run.stderr}`);
    assert.match(run.stdout, /mechanism exemption: packages\/core\/src\/lib\/state\/slot\.ts/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the checkout this fixture lives in passes the rule", () => {
  const run = spawnSync(process.execPath, [CHECKER], { encoding: "utf8" });
  assert.equal(run.status, 0, `the real tree failed: ${run.stdout}${run.stderr}`);
  assert.match(run.stdout, /Global slot check\.\.\. PASS/);
});
