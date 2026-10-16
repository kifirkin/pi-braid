/**
 * contrib toggles: `braid.contrib.<name>: false` silences a module at load.
 *
 * The bundle entry (index.ts) honors the toggle, but pi loads the
 * `pi.extensions` entries directly and never executes the bundle, so on a
 * package-registered install the toggle only works if each module's own
 * factory reads it. This test drives every gated factory with a recording
 * ExtensionAPI stub and a fresh agent directory and asserts the switch is
 * real: `false` registers nothing; every other shape (absent key, `true`, an
 * unreadable settings.json) still registers.
 *
 * Each case gets its own temp dir, and HOME points at the same dir, so a
 * module's homedir-based reader cannot see the developer's real settings and
 * make a case pass or fail for the wrong reason.
 *
 * Run with:
 *   node --experimental-strip-types --import ./test/lib/register-ts-resolve.mjs \
 *     test/contrib-toggles.test.mjs
 * (from packages/contrib).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * One row per gated module: the entry file and the key(s) the factory reads,
 * canonical first. `rate-limiter` keeps its deprecated hyphenated spelling for
 * one release.
 */
const MODULES = [
  { name: "browser", entry: "../browser/index.ts", keys: ["browser"] },
  { name: "codebase", entry: "../codebase/index.ts", keys: ["codebase"] },
  { name: "diff", entry: "../diff/index.ts", keys: ["diff"] },
  {
    name: "healthcheck",
    entry: "../healthcheck/index.ts",
    keys: ["healthcheck"],
  },
  { name: "repl", entry: "../repl/index.ts", keys: ["repl"] },
  { name: "sleep", entry: "../sleep/index.ts", keys: ["sleep"] },
  {
    name: "system-monitor",
    entry: "../system-monitor/index.ts",
    keys: ["systemMonitor"],
  },
  {
    name: "tool-config",
    entry: "../tool-config/index.ts",
    keys: ["toolConfig"],
  },
  {
    name: "rate-limiter",
    entry: "../rate-limiter/index.ts",
    keys: ["rateLimiter", "rate-limiter"],
  },
];

/** A settings document carrying one contrib key. */
function contribDoc(key, value) {
  return { braid: { contrib: { [key]: value } } };
}

/** An ExtensionAPI stub that records every call and registers nothing. */
function recordingApi(calls) {
  const record =
    (name) =>
    (...args) => {
      calls.push({ name, args });
      return () => {}; // unsubscribe handle for handlers a factory keeps
    };
  return {
    registerTool: record("registerTool"),
    registerCommand: record("registerCommand"),
    on: record("on"),
    getAllTools: record("getAllTools"),
    getActiveTools: record("getActiveTools"),
    setActiveTools: record("setActiveTools"),
  };
}

const describeCalls = (calls) =>
  calls.length === 0
    ? "nothing"
    : `${calls.length} call(s): ${calls.map((c) => c.name).join(", ")}`;

/**
 * Run one factory once in a fresh world: HOME and PI_CODING_AGENT_DIR point at
 * a temp dir seeded with `document` (an object is JSON-serialized, a string is
 * written verbatim, `null` leaves no settings file). Returns the recorded
 * calls.
 */
async function factoryCalls(entry, document) {
  const dir = mkdtempSync(join(tmpdir(), "contrib-toggle-"));
  const savedHome = process.env.HOME;
  const savedAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.HOME = dir;
  process.env.PI_CODING_AGENT_DIR = dir;
  if (document !== null) {
    writeFileSync(
      join(dir, "settings.json"),
      typeof document === "string" ? document : JSON.stringify(document),
    );
  }
  try {
    const mod = await import(new URL(entry, import.meta.url).href);
    const calls = [];
    mod.default(recordingApi(calls));
    return calls;
  } finally {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    if (savedAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = savedAgentDir;
    rmSync(dir, { recursive: true, force: true });
  }
}

for (const row of MODULES) {
  const canonical = row.keys[0];

  test(`${row.name}: ${canonical}: false registers nothing`, async () => {
    const calls = await factoryCalls(row.entry, contribDoc(canonical, false));
    assert.equal(
      calls.length,
      0,
      `${row.name} registered ${describeCalls(calls)} with ${canonical}: false`,
    );
  });

  test(`${row.name}: absent key registers`, async () => {
    const calls = await factoryCalls(row.entry, {});
    assert.ok(
      calls.length >= 1,
      `${row.name} registered nothing with no ${canonical} key`,
    );
  });

  test(`${row.name}: ${canonical}: true registers`, async () => {
    const calls = await factoryCalls(row.entry, contribDoc(canonical, true));
    assert.ok(
      calls.length >= 1,
      `${row.name} registered nothing with ${canonical}: true`,
    );
  });

  test(`${row.name}: an unreadable settings.json registers`, async () => {
    const calls = await factoryCalls(row.entry, "{ not json");
    assert.ok(
      calls.length >= 1,
      `${row.name} registered nothing beside an unreadable settings.json`,
    );
  });
}

test("rate-limiter: the deprecated hyphenated spelling still disables", async () => {
  const calls = await factoryCalls(
    "../rate-limiter/index.ts",
    contribDoc("rate-limiter", false),
  );
  assert.equal(
    calls.length,
    0,
    `rate-limiter registered ${describeCalls(calls)} with rate-limiter: false`,
  );
});

test("rate-limiter: canonical true outvotes a stale deprecated false", async () => {
  const calls = await factoryCalls("../rate-limiter/index.ts", {
    braid: { contrib: { rateLimiter: true, "rate-limiter": false } },
  });
  assert.ok(
    calls.length >= 1,
    "rateLimiter: true must win over the deprecated spelling",
  );
});

test("rate-limiter: canonical false disables beside a deprecated true", async () => {
  const calls = await factoryCalls("../rate-limiter/index.ts", {
    braid: { contrib: { rateLimiter: false, "rate-limiter": true } },
  });
  assert.equal(
    calls.length,
    0,
    `rate-limiter registered ${describeCalls(calls)} with rateLimiter: false`,
  );
});
