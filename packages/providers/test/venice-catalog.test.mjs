// venice-catalog.test.mjs — userland catalog seam contract.
//
// The agent-zero provider must register ONLY when the userland catalog file
// exists and is well-formed; anything else degrades to "no provider"
// (key-ring plumbing unaffected). House pattern: compile
// venice-catalog.ts with the package's local tsc (CJS emit) into a temp dir,
// load via createRequire. No pi-ai import, no network.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(here, "..");
const tscBin = join(pkgRoot, "node_modules", "typescript", "bin", "tsc");
const buildDir = mkdtempSync(join(tmpdir(), "venice-catalog-build-"));
const tsc = spawnSync(
  "node",
  [
    tscBin,
    "--ignoreConfig",
    join(pkgRoot, "venice-catalog.ts"),
    "--outDir",
    buildDir,
    "--module",
    "commonjs",
    "--target",
    "ES2022",
    "--lib",
    "ES2022",
    "--strict",
    "--esModuleInterop",
    "--skipLibCheck",
  ],
  { cwd: pkgRoot, encoding: "utf-8" },
);
if (tsc.status !== 0) {
  console.error("tsc emit failed:\n" + (tsc.stdout || "") + (tsc.stderr || ""));
  process.exit(1);
}
const require = createRequire(import.meta.url);
const { loadVeniceCatalog, defaultVeniceCatalogPath } = require(
  join(buildDir, "venice-catalog.js"),
);
after(() => rmSync(buildDir, { recursive: true, force: true }));

const VALID = {
  baseUrl: "https://llm.agent-zero.ai/v1",
  models: [
    {
      id: "deepseek-v4-pro-0813",
      name: "DeepSeek V4 Pro 0813",
      reasoning: true,
      input: ["text"],
      cost: { input: 1.65, output: 4.95 },
    },
    {
      id: "deepseek-v4-flash-0731",
      name: "DeepSeek V4 Flash 0731",
      reasoning: false,
      input: ["text"],
      cost: { input: 0.2, output: 0.6 },
    },
  ],
};

function tmpFile(content) {
  const dir = mkdtempSync(join(tmpdir(), "venice-catalog-"));
  const p = join(dir, "venice.json");
  writeFileSync(p, content);
  return p;
}

test("absent file -> null (provider simply not registered)", () => {
  const dir = mkdtempSync(join(tmpdir(), "venice-catalog-"));
  assert.equal(loadVeniceCatalog(join(dir, "missing.json")), null);
  rmSync(dir, { recursive: true, force: true });
});

test("valid file -> catalog with baseUrl + filtered models", () => {
  const p = tmpFile(JSON.stringify(VALID));
  const catalog = loadVeniceCatalog(p);
  assert.ok(catalog, "must load a valid catalog");
  assert.equal(catalog.baseUrl, "https://llm.agent-zero.ai/v1");
  assert.equal(catalog.models.length, 2);
  assert.equal(catalog.models[0].id, "deepseek-v4-pro-0813");
  unlinkSync(p);
});

test("env override: VENICE_CATALOG_FILE steers the default path", () => {
  const p = tmpFile(JSON.stringify(VALID));
  process.env.VENICE_CATALOG_FILE = p;
  try {
    const catalog = loadVeniceCatalog();
    assert.ok(catalog, "env override must be honored by the default path");
    assert.equal(catalog.models.length, 2);
  } finally {
    delete process.env.VENICE_CATALOG_FILE;
    unlinkSync(p);
  }
});

test("malformed JSON -> null", () => {
  const p = tmpFile("{not json");
  assert.equal(loadVeniceCatalog(p), null);
  unlinkSync(p);
});

test("wrong shape (no baseUrl / no models array) -> null", () => {
  const a = tmpFile(JSON.stringify({ models: VALID.models }));
  assert.equal(loadVeniceCatalog(a), null, "missing baseUrl must yield null");
  unlinkSync(a);
  const b = tmpFile(
    JSON.stringify({ baseUrl: "https://llm.agent-zero.ai/v1", models: {} }),
  );
  assert.equal(loadVeniceCatalog(b), null, "non-array models must yield null");
  unlinkSync(b);
});

test("non-https baseUrl -> null (defense-in-depth)", () => {
  const p = tmpFile(
    JSON.stringify({
      baseUrl: "ftp://llm.agent-zero.ai/v1",
      models: VALID.models,
    }),
  );
  assert.equal(loadVeniceCatalog(p), null);
  unlinkSync(p);
});

test("models with non-string ids are dropped; empty result -> null", () => {
  const p = tmpFile(
    JSON.stringify({
      baseUrl: "https://llm.agent-zero.ai/v1",
      models: [{ id: 42 }, "x"],
    }),
  );
  assert.equal(loadVeniceCatalog(p), null);
  unlinkSync(p);
});

test("default path resolves under ~/.pi/agent unless VENICE_CATALOG_FILE is set", () => {
  delete process.env.VENICE_CATALOG_FILE;
  const p = defaultVeniceCatalogPath();
  assert.ok(p.includes(join(".pi", "agent", "venice-models.json")), p);
});
