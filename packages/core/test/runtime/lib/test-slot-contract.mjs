// test-slot-contract.mjs - the slot contract, including its refusals.
//
// WHY THIS FILE EXISTS:
//   A process-global slot is a `globalThis` string key plus a cast. That is a
//   transport, not a contract: a value written by one module instance is read
//   by another with no statement about its shape or the build that wrote it.
//   slot.ts adds the statement; this file asserts that a wrong shape, a wrong
//   version and an absent writer are refused loudly instead of defaulting.
//
// THE PLANTED CONTROL:
//   The version case writes through a build that declares version 1 and reads
//   through a descriptor that declares version 2. The assertion is on the
//   message containing BOTH versions, not merely that a read threw: a slot
//   layer that throws "unreadable" for everything would pass a throw-only
//   test and refuse nothing meaningful.
//
// TWO MODULE INSTANCES:
//   Cache-busting re-imports (?v=N) force two evaluations of slot.ts in one
//   process, the same simulation test-custom-model-keys.mjs uses for the
//   src/dist split. The shared value lives on globalThis; the registry lives
//   on `Symbol.for`, so it counts both definitions.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SLOT_MODULE = new URL("../../../dist/lib/state/slot.js", import.meta.url);
const REGISTRY_MODULE = new URL(
  "../../../dist/lib/state/slot-registry.js",
  import.meta.url,
);

const instanceA = await import(`${SLOT_MODULE.href}?v=slot-a`);
const instanceB = await import(`${SLOT_MODULE.href}?v=slot-b`);
const registry = await import(`${REGISTRY_MODULE.href}?v=slot-a`);

const used = [];
function keyFor(name) {
  const key = `__braid_fixture_slot_${name}`;
  used.push(key);
  return key;
}

const parseMap = (value) =>
  value instanceof Map
    ? value
    : { refuse: `expected a Map<string, string>, found ${instanceA.describeValue(value)}` };

const parseNumber = (value) =>
  typeof value === "number"
    ? value
    : { refuse: `expected a number, found ${instanceA.describeValue(value)}` };

test("a correct write is read back through the declared parse", () => {
  const key = keyFor("basic");
  const slot = instanceA.defineSlot({ key, version: 1, owner: "fixture/basic", parse: parseMap });
  assert.notEqual(instanceA.defineSlot, instanceB.defineSlot, "the two imports must be separate evaluations");
  slot.set(new Map([["role", "route/model"]]));
  assert.equal(slot.get().get("role"), "route/model");
});

test("a shape refusal names what was expected and what arrived", () => {
  const key = keyFor("shape");
  const slot = instanceA.defineSlot({ key, version: 1, owner: "fixture/shape", parse: parseMap });
  // Written past the slot, the way a foreign writer's bare value arrives.
  globalThis[key] = "not a map";
  assert.throws(
    () => slot.get(),
    /expected a Map<string, string>, found string "not a map"/,
  );
});

test("planted control: a version 1 write read by a version 2 descriptor names both versions", () => {
  const key = keyFor("version");
  const writer = instanceA.defineSlot({ key, version: 1, owner: "fixture/version-1", parse: parseNumber });
  writer.set(7);
  const reader = instanceB.defineSlot({ key, version: 2, owner: "fixture/version-2", parse: parseNumber });
  assert.throws(
    () => reader.get(),
    (error) => {
      assert.match(error.message, /expected version 2/);
      assert.match(error.message, /found version 1/);
      return true;
    },
  );
});

test("a read with no writer throws instead of defaulting", () => {
  const key = keyFor("absent");
  const slot = instanceA.defineSlot({ key, version: 1, owner: "fixture/absent", parse: parseNumber });
  assert.equal(slot.tryGet(), undefined);
  assert.throws(
    () => slot.get(),
    new RegExp(`slot "${key}": expected version 1, found no version \\(absent\\); no writer has run in this process \\(expected owner: fixture/absent\\)`),
  );
});

test("a read-only slot refuses a write", () => {
  const key = keyFor("readonly");
  const slot = instanceA.defineSlot({
    key,
    version: 1,
    owner: "fixture/readonly",
    parse: parseNumber,
    writesExpected: false,
  });
  assert.throws(() => slot.set(1), /is read-only: the descriptor declares writesExpected: false/);
  assert.equal(globalThis[key], undefined, "a refused write installs nothing");
});

test("a writer that hands the wrong shape is refused at the writer", () => {
  const key = keyFor("writer");
  const slot = instanceA.defineSlot({ key, version: 1, owner: "fixture/writer", parse: parseNumber });
  assert.throws(
    () => slot.set("not a number"),
    /write refused at version 1; parse refused: expected a number, found string "not a number"/,
  );
  assert.equal(globalThis[key], undefined, "the bad value never reached the global");
});

test("requiresSubscriber advises once per process, not once per write", () => {
  const key = keyFor("advisory");
  const dir = mkdtempSync(join(tmpdir(), "slot-advisory-"));
  try {
    const child = join(dir, "write-three.mjs");
    writeFileSync(
      child,
      [
        `import { defineSlot } from ${JSON.stringify(SLOT_MODULE.href)};`,
        `const slot = defineSlot({`,
        `  key: ${JSON.stringify(key)},`,
        `  version: 1,`,
        `  owner: "fixture/advisory",`,
        `  parse: (value) => (typeof value === "number" ? value : { refuse: "expected a number" }),`,
        `  requiresSubscriber: true,`,
        `});`,
        `slot.set(1);`,
        `slot.set(2);`,
        `slot.set(3);`,
        ``,
      ].join("\n"),
      "utf8",
    );
    const run = spawnSync(process.execPath, [child], { encoding: "utf8" });
    assert.equal(run.status, 0, `the child failed: ${run.stderr}`);
    const advisories = run.stderr
      .split("\n")
      .filter((line) => line.includes("slot advisory") && line.includes(key));
    assert.equal(advisories.length, 1, `one advisory across three writes, got: ${run.stderr}`);
    assert.match(advisories[0], /owner fixture\/advisory/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("two module instances read one value and the census counts both definitions", () => {
  const key = keyFor("shared");
  const one = instanceA.defineSlot({ key, version: 1, owner: "fixture/shared", parse: parseMap });
  const two = instanceB.defineSlot({ key, version: 1, owner: "fixture/shared", parse: parseMap });
  one.set(new Map([["a", "b"]]));
  assert.equal(two.get().get("a"), "b", "the second evaluation sees the first evaluation's write");
  const row = registry.slotCensus().find((entry) => entry.key === key);
  assert.ok(row, "the census carries the declared slot");
  assert.equal(row.definitions, 2, "both module instances are counted");
  assert.equal(row.version, 1);
  assert.equal(row.owner, "fixture/shared");
  assert.equal(row.present, true);
});

test("clear() returns the slot to the absent state", () => {
  const key = keyFor("clear");
  const slot = instanceA.defineSlot({ key, version: 1, owner: "fixture/clear", parse: parseNumber });
  slot.set(3);
  slot.clear();
  assert.equal(slot.tryGet(), undefined);
  assert.throws(() => slot.get(), /found no version \(absent\)/);
});

test("describe() and the census report version, owner, age and subscribers", () => {
  const key = keyFor("described");
  const slot = instanceA.defineSlot({ key, version: 1, owner: "fixture/described", parse: parseNumber });
  slot.set(5);
  const described = slot.describe();
  assert.equal(described.version, 1);
  assert.equal(described.owner, "fixture/described");
  assert.equal(described.present, true);
  assert.ok(described.ageMs !== null && described.ageMs >= 0, "a stamped value has an age");
  const unsubscribe = slot.subscribe(() => {});
  assert.equal(slot.describe().subscribers, 1);
  unsubscribe();
  assert.equal(slot.describe().subscribers, 0);
  const row = registry.slotCensus().find((entry) => entry.key === key);
  assert.deepEqual(
    { version: row.version, owner: row.owner, present: row.present },
    { version: 1, owner: "fixture/described", present: true },
  );
});

test("cleanup", () => {
  for (const key of used) delete globalThis[key];
});
