/**
 * test-braid-schema-gate.mjs — the braid.* schema generator and drift gate.
 *
 * The generator's job is to stop the config reference from being hand-trusted:
 * defaults come out of reader source mechanically, and the gate fails when the
 * artifact or the reference drifts from code. These tests drive the exported
 * functions over a fixture reader and a fixture doc, and the CLI over the real
 * tree: the shipped default path, plus references built from the committed
 * artifact. No case reads anything outside the repository.
 *
 * Cases (RED arms marked):
 *   1. literal defaults extracted from a fixture reader (JSDoc + arithmetic)
 *   2. RED: an overlay row whose source line lacks the evidence text fails
 *   3. RED: a stale artifact (or a missing one) fails the freshness arm
 *   4. RED: a doc row whose key is absent from the schema fails
 *   5. RED: a doc-stated default that disagrees with the schema fails
 *   6. the fixture doc compares clean; `<ext>` wildcard keys resolve
 *   7. RED: a doc row without a valid Status cell fails
 *   8. non-braid.* rows are skipped
 *   9. RED: a missing reference is a counted skip, not a failure (exit 0)
 *  10. CLI: a reference built from the artifact compares clean (exit 0)
 *  11. RED: CLI, a reference default that disagrees with the artifact (exit 1)
 *  12. the shipped default path is green with nothing beside the checkout
 *  13. coverage: a literal resolves by exact row or by a child row; an
 *      uncovered literal fails carrying its first file:line
 *  14. coverage: dynamic segments and the commented exclusion list are skips,
 *      not failures
 *  15. coverage: the census walks package sources and skips test material
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "../../..");
const FIXTURES = join(HERE, "fixtures");
const GATE = join(ROOT, "scripts", "check-braid-schema.mjs");
const SCHEMA = join(ROOT, "schema", "braid.schema.json");

const { generateSchema, extractConstDefault, resolveRowDefault } = await import(
  "../../../scripts/gen-braid-schema.mjs"
);
const { checkFreshness, checkDoc, docArm, parseDocRows, resolveDocPath } = await import(
  "../../../scripts/check-braid-schema.mjs"
);
const { censusSourceLiterals, checkLiteralCoverage } = await import(
  "../../../scripts/check-braid-schema.mjs"
);

const READ_FILE = "reader.ts";
const fixtureText = readFileSync(join(FIXTURES, READ_FILE), "utf8");

/** Rows over the fixture reader: three mechanical, two overlay. */
const FIXTURE_ROWS = {
  mechanical: [
    {
      path: "braid.ctx.cap.enabled",
      type: "boolean",
      description: "gate",
      read: { file: READ_FILE, line: 14, evidence: "parsed.braid?.ctx?.cap" },
      mech: { const: "CAP_DEFAULTS", prop: "enabled" },
    },
    {
      path: "braid.ctx.cap.maxChars",
      type: "number",
      description: "cap",
      read: { file: READ_FILE, line: 14, evidence: "parsed.braid?.ctx?.cap" },
      mech: { const: "CAP_DEFAULTS", prop: "maxChars" },
    },
    {
      path: "braid.ctx.cap.windowMs",
      type: "number",
      description: "window",
      read: { file: READ_FILE, line: 14, evidence: "parsed.braid?.ctx?.cap" },
      mech: { const: "CAP_DEFAULTS", prop: "windowMs" },
    },
  ],
  overlay: [
    {
      path: "braid.ctx.cap.limit",
      type: "number",
      default: 1234,
      description: "limit",
      read: { file: READ_FILE, line: 11, evidence: "export const CAP_LIMIT = 1234;" },
    },
    {
      path: "braid.ctx.preset",
      type: "string",
      default: null,
      description: "preset",
      read: { file: READ_FILE, line: 14, evidence: "parsed.braid?.ctx?.cap" },
    },
  ],
};

const FIXTURE_CONSTS = { CAP_DEFAULTS: READ_FILE, CAP_LIMIT: READ_FILE };
const fixtureSchema = () =>
  generateSchema({ readerFiles: [READ_FILE], rows: FIXTURE_ROWS, constSources: FIXTURE_CONSTS }, FIXTURES);

const docGreen = readFileSync(join(FIXTURES, "doc.txt"), "utf8");

/**
 * A reference doc over keys taken from the committed artifact, so the CLI's doc
 * arm runs on in-repo inputs. Literal defaults are read out of the artifact
 * rather than restated here: a fixture that repeated them would be a second
 * copy to update every time a default moves.
 */
function referenceOver(keys, literalOverrides = {}) {
  const tree = JSON.parse(readFileSync(SCHEMA, "utf8"));
  const rows = [
    "| key | type | default | status | description | read at (file:line) |",
    "| --- | --- | --- | --- | --- | --- |",
  ];
  for (const key of keys) {
    const node = key
      .split(".")
      .slice(1)
      .reduce((n, seg) => n?.properties?.[seg], tree.properties.braid);
    assert.ok(node && node.default !== undefined, `reference key has no literal default: ${key}`);
    const literal =
      literalOverrides[key] ??
      (typeof node.default === "string" ? `"${node.default}"` : String(node.default));
    rows.push(`| \`${key}\` | ${node.type ?? "object"} | \`${literal}\` | ACTIVE | fixture | n/a |`);
  }
  return rows.join("\n") + "\n";
}

/** Reference rows whose literals must keep agreeing with the artifact. */
const REFERENCE_KEYS = ["braid.suppressNudges", "braid.timezone", "braid.timers.maxWakeAttempts"];

test("generator: literal defaults extracted, comments and arithmetic included", () => {
  const { text, counts } = fixtureSchema();
  const tree = JSON.parse(text);
  const cap = tree.properties.braid.properties.ctx.properties.cap;
  assert.equal(cap.properties.enabled.default, true);
  assert.equal(cap.properties.maxChars.default, 4000);
  assert.equal(cap.properties.windowMs.default, 1200000, "20 * 60 * 1000 must evaluate");
  assert.equal(cap.properties.limit.default, 1234);
  assert.equal(Object.keys(cap.properties).length, 4);
  assert.deepEqual(counts, { total: 5, mechanical: 3, overlay: 2 });
});

test("generator: scalar constant extraction and property selection", () => {
  assert.equal(extractConstDefault(fixtureText, "CAP_LIMIT", null), 1234);
  assert.throws(
    () => extractConstDefault(fixtureText, "CAP_LIMIT", "maxChars"),
    /scalar; no property/,
  );
  assert.throws(() => extractConstDefault(fixtureText, "CAP_DEFAULTS", null), /property is required/);
  assert.throws(() => extractConstDefault(fixtureText, "CAP_DEFAULTS", "ghost"), /not found/);
  assert.throws(() => extractConstDefault(fixtureText, "NO_SUCH_CONST", null), /not found/);
});

test("RED: overlay row whose source line lacks the evidence text fails", () => {
  const texts = new Map([[READ_FILE, fixtureText]]);
  const bad = {
    path: "braid.ctx.ghost",
    type: "boolean",
    default: false,
    description: "ghost",
    // Line 4 is the constant declaration; it cannot prove braid.ctx.ghost exists.
    read: { file: READ_FILE, line: 4, evidence: "braid.ctx.ghost" },
  };
  assert.throws(() => resolveRowDefault(bad, texts), /existence check failed for braid\.ctx\.ghost/);
  const notAReader = { ...bad, read: { file: "nope.ts", line: 1, evidence: "x" } };
  assert.throws(() => resolveRowDefault(notAReader, texts), /not a reader/);
});

test("RED: stale or missing artifact fails the freshness arm", () => {
  const fresh = fixtureSchema().text;
  assert.equal(checkFreshness(fresh, fresh).ok, true);
  const stale = fresh.replace('"default": 4000', '"default": 3999');
  const staleResult = checkFreshness(stale, fresh);
  assert.equal(staleResult.ok, false);
  assert.match(staleResult.errors[0], /stale/);
  const missing = checkFreshness(null, fresh);
  assert.equal(missing.ok, false);
  assert.match(missing.errors[0], /artifact missing/);
});

test("RED: a doc row whose key is absent from the schema fails", () => {
  const schema = fixtureSchema().text;
  const ghostDoc = docGreen + "| `braid.ctx.ghost` | boolean | `true` | ACTIVE | ghost | nowhere |\n";
  const result = checkDoc(schema, ghostDoc);
  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /key missing from schema: braid\.ctx\.ghost/);
});

test("RED: a doc-stated default that disagrees with the schema fails", () => {
  const schema = fixtureSchema().text;
  const badDoc = docGreen.replace("`1200000`", "`90000`");
  const result = checkDoc(schema, badDoc);
  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /doc default mismatch: braid\.ctx\.cap\.windowMs/);
});

test("doc arm: fixture doc compares clean; wildcard keys resolve against the artifact", () => {
  const result = checkDoc(fixtureSchema().text, docGreen);
  assert.equal(result.ok, true, result.errors.join("\n"));
  assert.equal(result.docRows, 4);
  assert.equal(result.compared, 4);

  const wildcardDoc =
    "| `braid.contrib.<ext>.enabled` | string[] | `undefined` (all tools) | ACTIVE | x | y |\n";
  const live = checkDoc(readFileSync(SCHEMA, "utf8"), wildcardDoc);
  assert.equal(live.ok, true, live.errors.join("\n"));
});

test("RED: a doc row without a valid Status cell fails", () => {
  const schema = fixtureSchema().text;
  const noStatus =
    docGreen + "| `braid.ctx.cap.extra` | boolean | `true` |  | ghost | nowhere |\n";
  const missing = checkDoc(schema, noStatus);
  assert.equal(missing.ok, false);
  assert.match(missing.errors.join("\n"), /status missing or invalid: braid\.ctx\.cap\.extra/);

  const badStatus = docGreen.replace("`4000` | ACTIVE", "`4000` | LEGACY");
  const bad = checkDoc(schema, badStatus);
  assert.equal(bad.ok, false);
  assert.match(bad.errors.join("\n"), /status missing or invalid: braid\.ctx\.cap\.maxChars/);

  const clean = checkDoc(schema, docGreen);
  assert.equal(clean.ok, true, clean.errors.join("\n"));
});

test("doc arm: non-braid rows are skipped", () => {
  const rows = parseDocRows("| `visionModel` | string | unset | x | y |\n| `braid.timezone` | string | `x` | y | z |\n");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].key, "braid.timezone");
});

test("RED: a missing reference is a counted skip, not a failure (exit 0)", () => {
  const schema = fixtureSchema().text;
  const tmp = mkdtempSync(join(tmpdir(), "braid-schema-test-"));
  try {
    const advisory = docArm(null, schema, tmp);
    assert.equal(advisory.ok, true);
    assert.equal(advisory.advisory, true);
    assert.match(advisory.output, /0 braid\.\* row\(s\) compared/);
    assert.match(advisory.output, /pass --doc/);
    assert.ok(advisory.output.includes(tmp), "the skip names the directory it looked in");
    assert.equal(resolveDocPath([], tmp), null, "empty notes dir resolves to no doc");
    const named = join(tmp, "named.md");
    assert.equal(
      resolveDocPath(["--doc", named], join(tmp, "absent-notes")),
      resolve(named),
      "an explicit --doc wins over the companion lookup",
    );
    const cli = execFileSync("node", [GATE, "--doc", join(tmp, "missing.md")], {
      cwd: ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    assert.match(cli, /doc check skipped: reference not present/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("CLI: a reference built from the artifact compares clean end to end", () => {
  const tmp = mkdtempSync(join(tmpdir(), "braid-schema-cli-"));
  try {
    const doc = join(tmp, "reference.md");
    writeFileSync(doc, referenceOver(REFERENCE_KEYS));
    const out = execFileSync("node", [GATE, "--doc", doc], {
      cwd: ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    assert.match(out, /✅ schema artifact fresh/);
    const n = REFERENCE_KEYS.length;
    assert.match(out, new RegExp(`✅ doc: ${n} braid\\.\\* row\\(s\\), ${n} literal default\\(s\\) compared`));
    assert.match(out, /✅ braid schema check passed/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("RED: CLI fails when a reference default disagrees with the artifact", () => {
  const tmp = mkdtempSync(join(tmpdir(), "braid-schema-cli-red-"));
  try {
    const doc = join(tmp, "reference.md");
    writeFileSync(doc, referenceOver(REFERENCE_KEYS, { "braid.timers.maxWakeAttempts": "4" }));
    const run = spawnSync("node", [GATE, "--doc", doc], { cwd: ROOT, encoding: "utf8" });
    assert.equal(run.status, 1);
    assert.match(run.stdout + run.stderr, /doc default mismatch: braid\.timers\.maxWakeAttempts/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("gate: the shipped default path is green with nothing beside the checkout", () => {
  const out = execFileSync("node", [GATE], { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  assert.match(out, /✅ schema artifact fresh/);
  // The doc arm announces itself either way — a comparison or a counted skip —
  // so a machine without a reference cannot pass silently.
  assert.match(out, /✅ doc: \d+ braid\.\* row\(s\),|doc check skipped: /);
  assert.match(out, /✅ braid schema check passed/);
});

test("coverage: a literal resolves by exact row or by a child row", () => {
  const rows = ["braid.ctx.cap.enabled", "braid.ctx.cap.maxChars", "braid.ctx.ghost"];
  const census = {
    files: 2,
    hits: new Map([
      // A block read: a child row is what proves the block exists.
      ["braid.ctx.cap", [{ file: "reader.ts", line: 14 }]],
      ["braid.ctx.cap.maxChars", [{ file: "reader.ts", line: 15 }]],
      ["braid.ctx.ghost", [{ file: "reader.ts", line: 16 }]],
      ["braid.ctx.cap.notARow", [{ file: "other.ts", line: 3 }]],
    ]),
  };
  const result = checkLiteralCoverage(census, rows);
  assert.equal(result.ok, false);
  assert.deepEqual(
    result.uncovered.map((u) => `${u.token}@${u.file}:${u.line}`),
    ["braid.ctx.cap.notARow@other.ts:3"],
    "a leaf no row names is the drift, and the failure names where it is read",
  );
  assert.equal(result.covered, 3);

  const clean = checkLiteralCoverage(census, [...rows, "braid.ctx.cap.notARow"]);
  assert.equal(clean.ok, true, JSON.stringify(clean.uncovered));
});

test("coverage: dynamic segments and the exclusion list are skips, not failures", () => {
  const census = {
    files: 1,
    hits: new Map([
      ["braid.contrib[extensionName]", [{ file: "a.ts", line: 1 }]],
      ["braid.contrib.<name>", [{ file: "a.ts", line: 2 }]],
      ["braid.version", [{ file: "b.ts", line: 3 }]],
      ["braid.ctx.cap", [{ file: "a.ts", line: 4 }]],
    ]),
  };
  const result = checkLiteralCoverage(census, ["braid.ctx.cap.enabled"]);
  assert.equal(result.ok, true, JSON.stringify(result.uncovered));
  assert.equal(result.dynamic, 2);
  assert.equal(result.excluded, 1);
  assert.equal(result.covered, 1);
});

test("coverage: the census walks package sources and skips test material", () => {
  const tmp = mkdtempSync(join(tmpdir(), "braid-schema-coverage-"));
  try {
    mkdirSync(join(tmp, "core", "src", "nested"), { recursive: true });
    mkdirSync(join(tmp, "core", "test"), { recursive: true });
    writeFileSync(
      join(tmp, "core", "src", "nested", "reader.ts"),
      "const a = parsed.braid?.ctx?.cap;\nconst b = parsed.braid?.contrib?.[extensionName];\n",
    );
    writeFileSync(join(tmp, "core", "src", "reader.test.ts"), "braid.ctx.ghost\n");
    writeFileSync(join(tmp, "core", "test", "fixture.ts"), "braid.ctx.ghost\n");
    const census = censusSourceLiterals(tmp);
    assert.deepEqual([...census.hits.keys()].sort(), [
      "braid.contrib[extensionName]",
      "braid.ctx.cap",
    ]);
    assert.equal(census.files, 1, "the .test.ts file and test/ are not readers");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("generator: the committed artifact is byte-stable", () => {
  const committed = readFileSync(SCHEMA, "utf8");
  const result = checkFreshness(committed, generateSchema().text);
  assert.equal(result.ok, true, result.errors.join("\n"));
});

test("generator: regeneration lands in a temp directory, never the repo", () => {
  const tmp = mkdtempSync(join(tmpdir(), "braid-schema-artifact-"));
  try {
    const regenerated = fixtureSchema().text;
    const artifact = join(tmp, "braid.schema.json");
    writeFileSync(artifact, regenerated);
    const result = checkFreshness(readFileSync(artifact, "utf8"), regenerated);
    assert.equal(result.ok, true, result.errors.join("\n"));
    assert.equal(readFileSync(SCHEMA, "utf8").includes('"braid.ctx.cap"'), false);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
