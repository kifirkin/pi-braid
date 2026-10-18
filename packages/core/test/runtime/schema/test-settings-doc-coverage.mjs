import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "../../..");
const GATE = join(ROOT, "scripts", "check-settings-doc-coverage.mjs");
const { scanSettingsDocCoverage } = await import(
  "../../../scripts/check-settings-doc-coverage.mjs"
);

function makeFixture(sourceText) {
  const tmp = mkdtempSync(join(tmpdir(), "braid-settings-doc-coverage-"));
  const packagesRoot = join(tmp, "packages");
  const sourceFile = join(packagesRoot, "core", "src", "reader.ts");
  mkdirSync(dirname(sourceFile), { recursive: true });
  writeFileSync(sourceFile, sourceText);
  return { tmp, packagesRoot, sourceFile };
}

function runGate(packagesRoot) {
  return spawnSync("node", [GATE, "--coverage-root", packagesRoot], {
    cwd: ROOT,
    encoding: "utf8",
  });
}

test("settings-doc coverage: a documented literal passes", () => {
  const fixture = makeFixture("const setting = parsed.braid?.docs?.probe;\n");
  try {
    const doc = join(fixture.packagesRoot, "core", "docs", "SETUP.md");
    mkdirSync(dirname(doc), { recursive: true });
    writeFileSync(doc, "| `braid.docs.probe` | default | effect |\n");

    const result = scanSettingsDocCoverage(fixture.packagesRoot);
    assert.equal(result.ok, true, JSON.stringify(result.uncovered));
    assert.deepEqual(result.covered.map((entry) => entry.token), ["braid.docs.probe"]);
    assert.equal(result.markdownFiles, 1);

    const run = runGate(fixture.packagesRoot);
    assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
    assert.match(run.stdout, /✅ settings doc coverage: 1 braid\.\* literal.*1 covered/);
  } finally {
    rmSync(fixture.tmp, { recursive: true, force: true });
  }
});

test("RED: an undocumented literal fails and names its source location", () => {
  const key = "braid.docs.missingFlag";
  const fixture = makeFixture("const setting = parsed.braid?.docs?.missingFlag;\n");
  try {
    const fixtureDoc = join(fixture.packagesRoot, "core", "test", "fixture.md");
    mkdirSync(dirname(fixtureDoc), { recursive: true });
    writeFileSync(fixtureDoc, `This is test data, not a human doc: ${key}\n`);

    const run = runGate(fixture.packagesRoot);
    assert.equal(run.status, 1, `${run.stdout}\n${run.stderr}`);
    assert.match(run.stdout, /❌ settings doc coverage: 1 braid\.\* literal/);
    assert.match(
      run.stderr,
      /braid\.docs\.missingFlag \(.*reader\.ts:1\): name this exact path/,
    );
  } finally {
    rmSync(fixture.tmp, { recursive: true, force: true });
  }
});

test("settings-doc coverage: the named internal exclusion is reported", () => {
  const fixture = makeFixture(
    "const metadata = braid.version;\nconst selected = parsed.braid?.contrib?.[extensionName];\n",
  );
  try {
    const result = scanSettingsDocCoverage(fixture.packagesRoot);
    assert.equal(result.ok, true, JSON.stringify(result.uncovered));
    assert.equal(result.excluded.length, 1);
    assert.equal(result.excluded[0].token, "braid.version");
    assert.match(result.excluded[0].reason, /not settings\.json/);
    assert.equal(result.dynamic.length, 1);

    const run = runGate(fixture.packagesRoot);
    assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
    assert.match(run.stdout, /braid\.version \(.*reader\.ts:1\): excluded: .*not settings\.json/);
    assert.match(run.stdout, /braid\.contrib\[extensionName\] .*dynamic path/);
  } finally {
    rmSync(fixture.tmp, { recursive: true, force: true });
  }
});
