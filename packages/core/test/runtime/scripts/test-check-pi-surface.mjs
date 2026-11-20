/**
 * check-pi-surface.mjs contract: the manifest compares to the declarations it
 * was recorded from, and the comparison fails on the member that moved.
 *
 * Every case builds a fake pi tree from the surface rows themselves - one
 * `interface` per recorded symbol, one member - so the fixture cannot drift
 * when a row is added. The modes are driven as child processes and judged on
 * exit code and printed text, which is the surface a reader and `ci:check`
 * see.
 *
 * The three cases that make the gate worth having are the ones that would pass
 * if the script compared the manifest to itself: a symbol removed from the
 * tree, a member retyped, and a tree that only moved a version number. The
 * first two must fail and name what moved; the third must pass and say both
 * versions.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { SURFACES } from "../../../scripts/pi-surface.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const script = resolve(here, "..", "..", "..", "scripts", "check-pi-surface.mjs");

/** Run one mode; stdout and stderr come back together with the exit code. */
function run(args, root) {
  try {
    const stdout = execFileSync(process.execPath, [script, ...args], {
      encoding: "utf8",
      env: { ...process.env, PI_SURFACE_PI_ROOT: root },
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { status: 0, output: stdout };
  } catch (err) {
    return { status: err.status ?? 1, output: `${err.stdout ?? ""}${err.stderr ?? ""}` };
  }
}

const SCOPED = ["node_modules", "@earendil-works"];

/**
 * A pi tree that satisfies every surface row: each symbol declared in the file
 * its row names, as an interface with `memberLines` for its body. Every row's
 * file is written even when all its symbols are omitted, so "the file is there
 * but the symbol is gone" is the common case and "the file is gone" is asked
 * for by name.
 */
function fakePi({
  root = mkdtempSync(join(tmpdir(), "pi-surface-")),
  version = "9.9.9",
  omit = [],
  dropFiles = [],
  memberLines = () => ["member: string"],
} = {}) {
  const byFile = new Map();
  for (const row of SURFACES) {
    const key = `${row.package}\u0000${row.file}`;
    const blocks = byFile.get(key) ?? [];
    for (const symbol of row.symbols) {
      if (omit.includes(`${row.name}/${symbol}`)) continue;
      const body = memberLines(row.name, symbol).map((line) => `    ${line};`);
      blocks.push([`export interface ${symbol} {`, ...body, "}"].join("\n"));
    }
    byFile.set(key, blocks);
  }
  const scoped = join(root, ...SCOPED);
  for (const pkg of new Set(SURFACES.map((row) => row.package))) {
    const dir = join(scoped, pkg.slice(pkg.lastIndexOf("/") + 1));
    mkdirSync(join(dir, "dist"), { recursive: true });
    writeFileSync(join(dir, "package.json"), `${JSON.stringify({ name: pkg, version }, null, 2)}\n`);
  }
  for (const [key, blocks] of byFile) {
    const [pkg, file] = key.split("\u0000");
    if (dropFiles.includes(file)) continue;
    const path = join(scoped, pkg.slice(pkg.lastIndexOf("/") + 1), file);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, blocks.length ? `${blocks.join("\n\n")}\n` : "export {};\n");
  }
  return root;
}

function piRoot(root) {
  return join(root, ...SCOPED, "pi-coding-agent");
}

function work() {
  return mkdtempSync(join(tmpdir(), "pi-surface-case-"));
}

/** Record a manifest from `root` into `dir`, asserting the record succeeded. */
function recordInto(dir, root, extra = []) {
  const manifest = join(dir, "pi-surface.json");
  const result = run(["--record", "--manifest", manifest, ...extra], piRoot(root));
  assert.equal(result.status, 0, `record failed:\n${result.output}`);
  return manifest;
}

test("a manifest recorded from a tree compares clean against it", () => {
  const dir = work();
  try {
    const root = fakePi();
    const manifest = recordInto(dir, root);
    const result = run(["--check", "--manifest", manifest], piRoot(root));
    assert.equal(result.status, 0, result.output);
    assert.match(result.output, /match/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("recording twice writes the same bytes", () => {
  const dir = work();
  try {
    const root = fakePi();
    const manifest = recordInto(dir, root);
    const first = readFileSync(manifest, "utf8");
    const again = run(["--record", "--manifest", join(dir, "second.json")], piRoot(root));
    assert.equal(again.status, 0, again.output);
    assert.equal(readFileSync(join(dir, "second.json"), "utf8"), first, "the record is a function of the tree");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a symbol removed from the tree fails and the line names it", () => {
  const dir = work();
  try {
    const recorded = fakePi();
    const manifest = recordInto(dir, recorded);
    const trimmed = fakePi({ omit: ["extension-api/ExtensionAPI"] });
    const result = run(["--check", "--manifest", manifest], piRoot(trimmed));
    assert.equal(result.status, 1, result.output);
    assert.match(result.output, /extension-api\/ExtensionAPI: gone/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a retyped member fails and the line names the member", () => {
  const dir = work();
  try {
    const manifest = recordInto(dir, fakePi());
    const retyped = fakePi({
      memberLines: (surface, symbol) =>
        surface === "session" && symbol === "SessionEntry" ? ["member: number"] : ["member: string"],
    });
    const result = run(["--check", "--manifest", manifest], piRoot(retyped));
    assert.equal(result.status, 1, result.output);
    assert.match(result.output, /session\/SessionEntry: member "member" changed: recorded "member: string", now "member: number"/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an added member passes and is reported as an addition", () => {  const dir = work();
  try {
    const manifest = recordInto(dir, fakePi());
    const extended = fakePi({
      memberLines: (surface, symbol) =>
        surface === "settings" && symbol === "SettingsManager"
          ? ["member: string", "extra?: boolean"]
          : ["member: string"],
    });
    const result = run(["--check", "--manifest", manifest], piRoot(extended));
    assert.equal(result.status, 0, result.output);
    assert.match(result.output, /additive change/);
    assert.match(result.output, /new member "extra"/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a version bump alone passes and names both versions", () => {
  const dir = work();
  try {
    const manifest = recordInto(dir, fakePi({ version: "9.9.9" }));
    const bumped = fakePi({ version: "9.9.10" });
    const result = run(["--check", "--manifest", manifest], piRoot(bumped));
    assert.equal(result.status, 0, result.output);
    assert.match(result.output, /recorded against @earendil-works\/pi-coding-agent 9\.9\.9, installed 9\.9\.10/);
    assert.match(result.output, /the recorded symbols are identical/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("recording refuses a symbol its file does not declare", () => {
  const dir = work();
  try {
    const manifest = join(dir, "pi-surface.json");
    const dropped = fakePi({ omit: ["model-registry/ModelRegistry"] });
    const result = run(["--record", "--manifest", manifest], piRoot(dropped));
    assert.equal(result.status, 1, result.output);
    assert.match(result.output, /surface "model-registry": .* does not declare ModelRegistry/);
    assert.match(result.output, /no declaration of it exists/);
    assert.throws(() => readFileSync(manifest, "utf8"), "a refused record writes nothing");

    const deleted = fakePi({ dropFiles: ["dist/core/model-registry.d.ts"] });
    const missingFile = run(["--record", "--manifest", manifest], piRoot(deleted));
    assert.equal(missingFile.status, 1, missingFile.output);
    assert.match(missingFile.output, /surface "model-registry": .* does not declare ModelRegistry/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a manifest of an unknown version is refused with the reason", () => {
  const dir = work();
  try {
    const root = fakePi();
    const manifest = join(dir, "pi-surface.json");
    writeFileSync(manifest, `${JSON.stringify({ version: 99, surfaces: {} }, null, 2)}\n`);
    const result = run(["--check", "--manifest", manifest], piRoot(root));
    assert.equal(result.status, 1, result.output);
    assert.match(result.output, /manifest version 99/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the reconciliation reports a version mismatch without failing", () => {
  const dir = work();
  try {
    const manifest = recordInto(dir, fakePi());
    const result = run(["--manifest", manifest], piRoot(fakePi()));
    assert.equal(result.status, 0, result.output);
    assert.match(result.output, /pi surface reconciliation/);
    assert.match(result.output, /NOT satisfied: installed 9\.9\.9/);
    assert.match(result.output, /present, signatures unchanged/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a signature that only appends optional parameters says so, a required one does not", () => {
  const dir = work();
  try {
    const manifest = recordInto(dir, fakePi({ memberLines: () => ["member(x: string): void"] }));
    const optional = fakePi({ memberLines: () => ["member(x: string, y?: number): void"] });
    const widened = run(["--check", "--manifest", manifest], piRoot(optional));
    assert.equal(widened.status, 1, widened.output);
    assert.match(widened.output, /member "member" changed/);
    assert.match(widened.output, /adds an optional parameter/);

    const required = fakePi({ memberLines: () => ["member(x: string, y: number): void"] });
    const broken = run(["--check", "--manifest", manifest], piRoot(required));
    assert.equal(broken.status, 1, broken.output);
    assert.match(broken.output, /member "member" changed/);
    assert.doesNotMatch(broken.output, /optional parameter/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the workspace tree records and its overloads stay apart", () => {
  const dir = work();
  try {
    const manifest = join(dir, "pi-surface.json");
    const result = run(["--record", "--manifest", manifest], undefined);
    if (result.status !== 0) {
      assert.match(result.output, /install the workspace dependencies|no package\.json/);
      return;
    }
    const recorded = JSON.parse(readFileSync(manifest, "utf8"));
    assert.equal(Object.keys(recorded.surfaces).length, SURFACES.length);
    for (const [name, surface] of Object.entries(recorded.surfaces)) {
      assert.ok(Object.keys(surface.symbols).length > 0, `${name} recorded no symbols`);
    }
    const on = recorded.surfaces["extension-api"].symbols.ExtensionAPI.members.on;
    assert.ok(Array.isArray(on) && on.length > 1, "overloads are kept as separate lines");
    assert.ok(on.some((line) => line.includes('event: "tool_result"')), "the overload names its event");
    const model = recorded.surfaces["ai-types"].symbols.Model;
    assert.ok(Object.keys(model.members ?? {}).length > 0, "a cross-package symbol resolved with its members");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
