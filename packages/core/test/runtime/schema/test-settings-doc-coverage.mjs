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

function writePackageFile(packagesRoot, path, content) {
  const file = join(packagesRoot, path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
}

function makeFixture(
  sourceText,
  docText = "",
  { sourcePath = "core/src/reader.ts", docPath = "core/docs/SETUP.md" } = {},
) {
  const tmp = mkdtempSync(join(tmpdir(), "braid-settings-doc-signal-"));
  const packagesRoot = join(tmp, "packages");
  writePackageFile(packagesRoot, sourcePath, sourceText);
  writePackageFile(packagesRoot, docPath, docText);
  return { tmp, packagesRoot };
}

function runGate(packagesRoot) {
  return spawnSync("node", [GATE, "--coverage-root", packagesRoot], {
    cwd: ROOT,
    encoding: "utf8",
  });
}

function tokens(entries) {
  return entries.map((entry) => entry.token);
}

test("settings-doc signal: a table row documents a literal", () => {
  const fixture = makeFixture(
    "const setting = parsed.braid?.docs?.probe;\n",
    "| `braid.docs.probe` | `true` | Enables the probe. |\n",
  );
  try {
    const result = scanSettingsDocCoverage(fixture.packagesRoot);
    assert.equal(result.ok, true, JSON.stringify(result.uncovered));
    assert.deepEqual(tokens(result.covered), ["braid.docs.probe"]);
    assert.equal(result.markdownFiles, 1);

    const run = runGate(fixture.packagesRoot);
    assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
    assert.match(run.stdout, /✅ settings doc signal check: 1 braid\.\* source path.*1 configuration-shaped literal mention/);
  } finally {
    rmSync(fixture.tmp, { recursive: true, force: true });
  }
});

test("plant: missing-static-canary", () => {
  const key = "braid.reviewProbe.unlisted";
  const fixture = makeFixture(
    "const setting = settings.braid?.reviewProbe?.unlisted;\n",
    "The setup page does not describe this setting.\n",
  );
  try {
    const result = scanSettingsDocCoverage(fixture.packagesRoot);
    assert.equal(result.ok, false);
    assert.deepEqual(tokens(result.uncovered), [key]);

    const run = runGate(fixture.packagesRoot);
    assert.equal(run.status, 1, `${run.stdout}\n${run.stderr}`);
    assert.match(run.stdout, /❌ settings doc signal check: 1 braid\.\* source path/);
    assert.match(run.stderr, /braid\.reviewProbe\.unlisted \(.*reader\.ts:1\): add a configuration-shaped/);
  } finally {
    rmSync(fixture.tmp, { recursive: true, force: true });
  }
});

test("plant: markdown-fenced-example", () => {
  const key = "braid.docs.fencedProbe";
  const fixture = makeFixture(
    "const setting = settings.braid.docs.fencedProbe;\n",
    `\`\`\`ts\n| \`${key}\` | Default | Effect |\n\`\`\`\n`,
  );
  try {
    const result = scanSettingsDocCoverage(fixture.packagesRoot);
    assert.equal(result.ok, false);
    assert.deepEqual(tokens(result.uncovered), [key]);
  } finally {
    rmSync(fixture.tmp, { recursive: true, force: true });
  }
});

test("plant: markdown-html-comment", () => {
  const key = "braid.docs.commentProbe";
  const fixture = makeFixture(
    "const setting = settings.braid.docs.commentProbe;\n",
    `<!-- | \`${key}\` | Default | Effect | -->\n`,
  );
  try {
    const result = scanSettingsDocCoverage(fixture.packagesRoot);
    assert.equal(result.ok, false);
    assert.deepEqual(tokens(result.uncovered), [key]);
  } finally {
    rmSync(fixture.tmp, { recursive: true, force: true });
  }
});

test("plant: bare-token-prose", () => {
  const key = "braid.docs.bareProbe";
  const fixture = makeFixture(
    "const setting = settings.braid.docs.bareProbe;\n",
    `The release note mentions \`${key}\` without a configuration explanation.\n`,
  );
  try {
    const result = scanSettingsDocCoverage(fixture.packagesRoot);
    assert.equal(result.ok, false);
    assert.deepEqual(tokens(result.uncovered), [key]);
  } finally {
    rmSync(fixture.tmp, { recursive: true, force: true });
  }
});

test("plant: runtime-template", () => {
  const fixture = makeFixture(
    "const key = `braid.providers.${name}`;\nreadSettings(key);\n",
    "| `braid.providers` | routes | Selects provider routes. |\n",
  );
  try {
    const result = scanSettingsDocCoverage(fixture.packagesRoot);
    assert.equal(result.ok, false);
    assert.deepEqual(tokens(result.dynamic), ["braid.providers.<name>"]);
    assert.deepEqual(tokens(result.unresolved), ["braid.providers.<name>"]);
    assert.deepEqual(tokens(result.covered), []);
  } finally {
    rmSync(fixture.tmp, { recursive: true, force: true });
  }
});

test("plant: variable-bracket-path", () => {
  const fixture = makeFixture(
    "const value = settings.braid[settingName];\n",
    "| `braid` | object | Contains settings. |\n",
  );
  try {
    const result = scanSettingsDocCoverage(fixture.packagesRoot);
    assert.equal(result.ok, false);
    assert.deepEqual(tokens(result.dynamic), ["braid[settingName]"]);
    assert.deepEqual(tokens(result.unresolved), ["braid[settingName]"]);
    assert.deepEqual(tokens(result.covered), []);
  } finally {
    rmSync(fixture.tmp, { recursive: true, force: true });
  }
});

test("plant: direct-nested-access", () => {
  const key = "braid.context.nestedProbe";
  const fixture = makeFixture(
    "const value = settings.braid?.context?.nestedProbe;\n",
    "| `braid.context` | object | Context settings. |\n",
  );
  try {
    const result = scanSettingsDocCoverage(fixture.packagesRoot);
    assert.equal(result.ok, false);
    assert.ok(result.uncovered.some((entry) => entry.token === key));
  } finally {
    rmSync(fixture.tmp, { recursive: true, force: true });
  }
});

test("plant: destructured-leaf", () => {
  const key = "braid.context.nestedProbe";
  const fixture = makeFixture(
    "const { nestedProbe } = settings.braid.context;\n",
    "| `braid.context` | object | Context settings. |\n",
  );
  try {
    const result = scanSettingsDocCoverage(fixture.packagesRoot);
    assert.equal(result.ok, false);
    assert.ok(result.uncovered.some((entry) => entry.token === key));
    assert.ok(!result.dynamic.some((entry) => entry.token.includes("nestedProbe")));
  } finally {
    rmSync(fixture.tmp, { recursive: true, force: true });
  }
});

test("plant: test-only-source", () => {
  const fixture = makeFixture(
    "const value = settings.braid.testOnlyProbe;\n",
    "",
    { sourcePath: "core/test/reader.ts" },
  );
  try {
    const result = scanSettingsDocCoverage(fixture.packagesRoot);
    assert.equal(result.ok, true);
    assert.equal(result.sourceFiles, 0);
    assert.equal(result.sourceLiterals, 0);
  } finally {
    rmSync(fixture.tmp, { recursive: true, force: true });
  }
});

test("plant: optional-dynamic-bracket", () => {
  const fixture = makeFixture(
    "const value = settings.braid?.providers?.[name];\n",
    "| `braid.providers` | object | Provider settings. |\n",
  );
  try {
    const result = scanSettingsDocCoverage(fixture.packagesRoot);
    assert.equal(result.ok, false);
    assert.deepEqual(tokens(result.dynamic), ["braid.providers[name]"]);
    assert.deepEqual(tokens(result.unresolved), ["braid.providers[name]"]);
  } finally {
    rmSync(fixture.tmp, { recursive: true, force: true });
  }
});

test("plant: full-path-variable", () => {
  const key = "braid.docs.variableProbe";
  const fixture = makeFixture(
    `const settingPath = "${key}";\nreadSettings(settingPath);\n`,
    "| `braid.docs` | object | Doc settings. |\n",
  );
  try {
    const result = scanSettingsDocCoverage(fixture.packagesRoot);
    assert.equal(result.ok, false);
    assert.deepEqual(tokens(result.uncovered), [key]);
  } finally {
    rmSync(fixture.tmp, { recursive: true, force: true });
  }
});

test("plant: non-special-heading", () => {
  const fixture = makeFixture(
    "const value = settings.braid.docs.headingProbe;\n",
    "### Experimental options\n\n| `braid.docs.headingProbe` | `false` | Turns on the experiment. |\n",
  );
  try {
    const result = scanSettingsDocCoverage(fixture.packagesRoot);
    assert.equal(result.ok, true, JSON.stringify(result.uncovered));
    assert.deepEqual(tokens(result.covered), ["braid.docs.headingProbe"]);
  } finally {
    rmSync(fixture.tmp, { recursive: true, force: true });
  }
});

test("plant: skipped-test-doc", () => {
  const key = "braid.docs.skippedProbe";
  const fixture = makeFixture(
    "const value = settings.braid.docs.skippedProbe;\n",
    `| \`${key}\` | \`false\` | Disables the probe. |\n`,
    { docPath: "core/test/fixture.md" },
  );
  try {
    const result = scanSettingsDocCoverage(fixture.packagesRoot);
    assert.equal(result.ok, false);
    assert.deepEqual(tokens(result.uncovered), [key]);
    assert.equal(result.markdownFiles, 0);
  } finally {
    rmSync(fixture.tmp, { recursive: true, force: true });
  }
});

test("configuration signal: a default/effect line documents a literal", () => {
  const fixture = makeFixture(
    "const value = settings.braid.docs.labeledProbe;\n",
    "Default: `braid.docs.labeledProbe` is `false`; Effect: the probe stays off.\n",
  );
  try {
    const result = scanSettingsDocCoverage(fixture.packagesRoot);
    assert.equal(result.ok, true, JSON.stringify(result.uncovered));
    assert.deepEqual(tokens(result.covered), ["braid.docs.labeledProbe"]);
  } finally {
    rmSync(fixture.tmp, { recursive: true, force: true });
  }
});

test("configuration signal: natural default/effect wording qualifies", () => {
  const fixture = makeFixture(
    "const value = settings.braid.docs.naturalProbe;\n",
    "By default, `braid.docs.naturalProbe` is disabled; its effect is to keep the probe off.\n",
  );
  try {
    const result = scanSettingsDocCoverage(fixture.packagesRoot);
    assert.equal(result.ok, true, JSON.stringify(result.uncovered));
    assert.deepEqual(tokens(result.covered), ["braid.docs.naturalProbe"]);
  } finally {
    rmSync(fixture.tmp, { recursive: true, force: true });
  }
});

test("configuration signal: pipe table without outer bars qualifies", () => {
  const fixture = makeFixture(
    "const value = settings.braid.docs.unwrappedTable;\n",
    "`braid.docs.unwrappedTable` | `false` | Disables the probe.\n",
  );
  try {
    const result = scanSettingsDocCoverage(fixture.packagesRoot);
    assert.equal(result.ok, true, JSON.stringify(result.uncovered));
    assert.deepEqual(tokens(result.covered), ["braid.docs.unwrappedTable"]);
  } finally {
    rmSync(fixture.tmp, { recursive: true, force: true });
  }
});

test("known constant bracket leaf: count the visible property as a literal", () => {
  const key = "braid.docs.literalProbe";
  const fixture = makeFixture(
    'export const SETTING_NAME = "literalProbe";\nconst value = settings.braid.docs[SETTING_NAME];\n',
    "| `braid.docs` | object | Doc settings. |\n",
  );
  try {
    const result = scanSettingsDocCoverage(fixture.packagesRoot);
    assert.equal(result.ok, false);
    assert.deepEqual(tokens(result.uncovered), [key]);
    assert.deepEqual(tokens(result.dynamic), []);
  } finally {
    rmSync(fixture.tmp, { recursive: true, force: true });
  }
});

test("dynamic family: a matching configuration-shaped row is reported", () => {
  const fixture = makeFixture(
    "const value = settings.braid.contrib[extensionName];\n",
    "| `braid.contrib.<name>` | object | Per-extension settings. |\n",
  );
  try {
    const result = scanSettingsDocCoverage(fixture.packagesRoot);
    assert.equal(result.ok, true, JSON.stringify(result.unresolved));
    assert.deepEqual(tokens(result.unresolved), []);
    assert.equal(result.dynamic.length, 1);
    assert.equal(result.dynamic[0].documented, true);
    assert.equal(result.dynamicDocumented[0].docLine, 1);
  } finally {
    rmSync(fixture.tmp, { recursive: true, force: true });
  }
});

test("plant: full-path-literal-variable-with-row", () => {
  const key = "braid.docs.variableProbe";
  const fixture = makeFixture(
    `const settingPath = "${key}";\nreadSettings(settingPath);\n`,
    `| \`${key}\` | \`false\` | Enables the probe. |\n`,
  );
  try {
    const result = scanSettingsDocCoverage(fixture.packagesRoot);
    assert.equal(result.ok, true, JSON.stringify(result.uncovered));
    assert.deepEqual(tokens(result.covered), [key]);
  } finally {
    rmSync(fixture.tmp, { recursive: true, force: true });
  }
});
