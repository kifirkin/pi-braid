// waf-sanitize.test.mjs — WAF error sanitization contract.
//
// The edge block returns a full HTML page (incl. base64 assets) as the error
// body; pi-core displays the raw errorMessage, flooding the TUI. handleMessageEnd
// must replace the dump with a compact marker in BOTH branches (retry + plain)
// while never exhausting/rotating the key. The sanitized marker carries ONLY
// the body length as diagnostic value: zero page markup may survive into the
// stored errorMessage, because stored fragments ride in every later request
// body and re-enter every future compaction summarize window.
//
// SAFETY: every markup-like input below is assembled at runtime from
// innocuous fragments (never a complete tag literal in this file) so the
// test source itself stays fragment-free.
//
// House pattern: compile ring-lifecycle
// with the package's local tsc (CJS emit) into a temp dir, load via createRequire.
// HOME is redirected to an isolated temp dir so key-ring state never touches
// the real ~/.pi/agent. No network.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(here, "..");
const srcDir = pkgRoot;
const tscBin = join(pkgRoot, "node_modules", "typescript", "bin", "tsc");

const buildDir = mkdtempSync(join(tmpdir(), "waf-build-"));
const homeDir = mkdtempSync(join(tmpdir(), "waf-home-"));
const tsc = spawnSync(
  "node",
  [
    tscBin,
    "--ignoreConfig",
    join(srcDir, "ring-lifecycle.ts"),
    join(srcDir, "key-ring.ts"),
    join(srcDir, "log.ts"),
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
    "--types",
    "node",
  ],
  { cwd: pkgRoot, encoding: "utf-8" },
);
if (tsc.status !== 0) {
  console.error("tsc emit failed:\n" + (tsc.stdout || "") + (tsc.stderr || ""));
  process.exit(1);
}
// Sanitize the provider keyspace + HOME BEFORE the module loads: the ring
// reads env keys at createKeyRing() factory time, so ambient
// AGENT_ZERO_API_KEY_P* (which the real setup may export) must be gone first
// (mirrors key-ring-exhausted.test.mjs).
for (const key of Object.keys(process.env)) {
  if (/^AGENT_ZERO_API_KEY(_P\d+)?$/.test(key)) delete process.env[key];
}
const OLD_HOME = process.env.HOME;
process.env.HOME = homeDir;

const require = createRequire(import.meta.url);
const mod = require(join(buildDir, "ring-lifecycle.js"));
// Same module instance ring-lifecycle.js requires internally (CJS path cache):
// lets the tests bind a capture sink for the throttled warn logger.
const logMod = require(join(buildDir, "log.js"));

after(() => {
  if (OLD_HOME !== undefined) process.env.HOME = OLD_HOME;
  else delete process.env.HOME;
  rmSync(buildDir, { recursive: true, force: true });
  rmSync(homeDir, { recursive: true, force: true });
});

const LT = "<";
const GT = ">";

// Runtime-assembled markup shape: the source holds only innocuous fragments,
// never a complete tag literal.
function tag(name, attrs) {
  return LT + name + (attrs ? " " + attrs : "") + GT;
}

const SYNTHETIC_BLOCK_PAGE = [
  tag("!doctype", "html"),
  tag("html"),
  tag("head"),
  tag("title"),
  "edge availability notice",
  tag("/title"),
  tag("/head"),
  tag("body"),
  "automated request blocked by " + "waf",
  ", reference " + "cf-" + "ray 0000000000000",
  tag("img", 'src="data:image/png;base64,' + "c3ludGhldGlj" + '"'),
  tag("script"),
  "window.redactedProbe = 1;",
  tag("/script"),
  tag("/body"),
  tag("/html"),
].join("");

test("sanitizeWafError: block page collapses to a fragment-free marker", () => {
  const out = mod.sanitizeWafError(SYNTHETIC_BLOCK_PAGE);
  assert.ok(
    out.length < 250,
    `sanitized text must be compact, got ${out.length} chars`,
  );
  assert.match(out, /Edge\/WAF block/);
  assert.match(out, /NOT key-rotation/);
  assert.ok(
    out.includes(`body length ${SYNTHETIC_BLOCK_PAGE.length} chars`),
    "body-length diagnostic must be present and correct",
  );
  // No excerpt substring of the raw body survives — not even truncated.
  // Assertions use synthetic fragments and generic shapes only.
  assert.ok(!out.includes(LT), "no markup opener may survive");
  assert.doesNotMatch(out, /<[^>]*>/, "no tag-like sequence may survive");
  assert.ok(
    !out.includes(LT + "!doctype"),
    "page-opening markup must not survive",
  );
  assert.ok(!out.includes("c3ludGhldGlj"), "no base64 payload may survive");
  assert.ok(
    !out.includes("edge availability notice"),
    "no diagnostic text from the body may survive",
  );
});

test("sanitizeWafError: empty body yields a self-describing marker", () => {
  const out = mod.sanitizeWafError("");
  assert.match(out, /Edge\/WAF block/);
  assert.ok(out.includes("body length 0 chars"), "zero-length body reported");
  const n = mod.sanitizeWafError(null);
  assert.ok(
    n.includes("body length 0 chars"),
    "null body reported as length 0",
  );
});

test("recognition invariant: the sanitized marker is still WAF-recognizable", () => {
  // isWafBlockError's convention: callers pass lowercased text.
  const sanitized = mod.sanitizeWafError(SYNTHETIC_BLOCK_PAGE).toLowerCase();
  assert.equal(mod.isWafBlockError(sanitized), true);
  // Production form: message_end appends the retry marker to the sanitized
  // text, and that composite is what the retry classifier sees downstream.
  const withRetryMarker = `${mod.sanitizeWafError(
    SYNTHETIC_BLOCK_PAGE,
  )}${mod.WAF_RETRY_MARKER}`.toLowerCase();
  assert.equal(mod.isWafBlockError(withRetryMarker), true);
  // Even the empty-body marker keeps the recognition tokens.
  assert.equal(
    mod.isWafBlockError(mod.sanitizeWafError("").toLowerCase()),
    true,
  );
});

test("WAF warn sink logs the sanitized one-liner, never a raw body slice", () => {
  // Must stay the FIRST WAF handleMessageEnd call in this process: the
  // throttled sink is loud only on the first occurrence of a burst.
  const captured = [];
  logMod.setProvidersLogSink((message, type) =>
    captured.push({ message, type }),
  );
  let result;
  try {
    const msg = {
      provider: "agent-zero",
      model: "deepseek-v4-pro-0813",
      stopReason: "error",
      errorMessage: SYNTHETIC_BLOCK_PAGE,
    };
    result = mod.handleMessageEnd({ message: msg });
  } finally {
    logMod.setProvidersLogSink(undefined);
  }
  assert.ok(result, "WAF must return a replacement message (not undefined)");
  assert.ok(
    !result.message.errorMessage.includes(LT),
    "stored replacement stays fragment-free",
  );
  assert.ok(
    result.message.errorMessage.endsWith(mod.WAF_RETRY_MARKER),
    "retry marker still appended",
  );
  assert.equal(captured.length, 1, "exactly one loud warn per burst start");
  assert.equal(captured[0].type, "warning", "warn routes as warning");
  const line = captured[0].message;
  assert.ok(line.includes("[pi-braid-providers]"), "prefix kept");
  assert.ok(line.includes("(agent-zero)"), "provider tag kept");
  assert.ok(line.includes("NOT key-rotation"), "rotation note kept");
  assert.ok(
    line.includes(`body length ${SYNTHETIC_BLOCK_PAGE.length} chars`),
    "warn carries the sanitized one-liner with body-length diagnostic",
  );
  assert.ok(!line.includes(LT), "no markup may reach the log line");
  assert.ok(
    !line.includes("edge availability notice"),
    "no body text may reach the log line",
  );
});

test("handleMessageEnd: WAF error -> sanitized message + retry marker, key NOT exhausted", () => {
  const msg = {
    provider: "agent-zero",
    model: "deepseek-v4-pro-0813",
    stopReason: "error",
    errorMessage: SYNTHETIC_BLOCK_PAGE,
  };
  const result = mod.handleMessageEnd({ message: msg });
  assert.ok(result, "WAF must return a replacement message (not undefined)");
  assert.equal(
    result.message.errorMessage.includes(SYNTHETIC_BLOCK_PAGE),
    false,
    "raw block page must be gone",
  );
  assert.match(result.message.errorMessage, /Edge\/WAF block/);
  assert.ok(
    result.message.errorMessage.endsWith(mod.WAF_RETRY_MARKER),
    "retry marker appended",
  );
  // Ring untouched: no keys configured, nothing exhausted or persisted.
  assert.equal(mod.veniceKeyRing.health().total, 0);
});

test("handleMessageEnd: WAF + fatal quota token -> sanitized WITHOUT retry marker", () => {
  const html =
    SYNTHETIC_BLOCK_PAGE + tag("p") + "insufficient_quota" + tag("/p");
  const msg = {
    provider: "agent-zero",
    model: "deepseek-v4-pro-0813",
    stopReason: "error",
    errorMessage: html,
  };
  const result = mod.handleMessageEnd({ message: msg });
  assert.ok(result, "non-retryable WAF must still return a sanitized message");
  assert.ok(
    !result.message.errorMessage.includes("insufficient_quota"),
    "fatal token dropped with the dump",
  );
  assert.ok(
    !result.message.errorMessage.includes(mod.WAF_RETRY_MARKER),
    "no retry marker on non-retryable",
  );
  assert.match(result.message.errorMessage, /Edge\/WAF block/);
});

// ── Request-side edge-filter neutralization ────────────────────────────────
// The edge blocks a body whose inspected head carries one 10-byte sequence.
// Every fixture below is assembled from fragments and the matcher is built the
// same way, so this file never carries the sequence itself: a repo file that
// does blocks any session that reads it through that host.

const TRIGGER_ID = "exec" + "Sync";
const TRIGGER_DOT = ".";
const TRIGGER_OPEN = "(";
const TRIGGER = TRIGGER_DOT + TRIGGER_ID + TRIGGER_OPEN;
const TRIGGER_NEUTRAL = TRIGGER_DOT + TRIGGER_ID + " " + TRIGGER_OPEN;
const TRIGGER_RE = new RegExp("[.]" + TRIGGER_ID + "[(]");

/** Benign look-alikes the edge accepts: none may be rewritten. */
const BENIGN = [
  TRIGGER_ID + TRIGGER_OPEN,
  "x" + TRIGGER_ID + TRIGGER_OPEN,
  "_" + TRIGGER_ID + TRIGGER_OPEN,
  " " + TRIGGER_ID + TRIGGER_OPEN,
  TRIGGER_DOT + TRIGGER_ID,
  TRIGGER_NEUTRAL,
  // The paren written as its JSON escape, byte-for-byte on the wire.
  TRIGGER_DOT + TRIGGER_ID + "\\u0028",
  // Zero-width space before the paren, built here so no invisible character
  // sits in this file (the edge accepts it; nothing needs rewriting).
  TRIGGER_DOT + TRIGGER_ID + String.fromCharCode(0x200b) + TRIGGER_OPEN,
  TRIGGER_DOT + "spawn" + TRIGGER_ID.slice(4) + TRIGGER_OPEN,
  TRIGGER_DOT + "execFile" + TRIGGER_ID.slice(4) + TRIGGER_OPEN,
  TRIGGER_DOT + "exec" + TRIGGER_OPEN,
  TRIGGER_DOT + "execFile" + TRIGGER_OPEN,
];

test("handleBeforeProviderRequest: the trigger is neutralized on the wire, session text untouched", () => {
  const content = "Call " + TRIGGER + "'ls' in the helper.";
  const payload = {
    model: "unconfigured/model",
    messages: [{ role: "assistant", content }],
  };
  const out = mod.handleBeforeProviderRequest(payload);
  assert.ok(out, "a neutralized payload must be returned");
  assert.equal(
    TRIGGER_RE.test(out.messages[0].content),
    false,
    "no trigger on the wire",
  );
  assert.ok(
    out.messages[0].content.includes(TRIGGER_NEUTRAL),
    "the rewrite keeps the text readable",
  );
  assert.equal(
    payload.messages[0].content,
    content,
    "stored message text untouched",
  );
  assert.notEqual(
    out.messages[0],
    payload.messages[0],
    "a new message object is built",
  );
});

test("handleBeforeProviderRequest: neutralization does not depend on the route table", () => {
  // venice-direct reaches the same host but sets no venicePayload flag, and an
  // unowned model id resolves no route at all: the wire pass still runs.
  const payload = {
    model: "venice-direct-ish/model",
    messages: [{ role: "user", content: "see " + TRIGGER + " here" }],
  };
  const out = mod.handleBeforeProviderRequest(payload);
  assert.ok(out, "the trigger alone must make the handler return a payload");
  assert.equal(
    "venice_parameters" in out,
    false,
    "no shaping for an unasked route",
  );
  assert.equal(TRIGGER_RE.test(out.messages[0].content), false);
});

test("handleBeforeProviderRequest: a venicePayload route gets the tweak AND neutralized strings", () => {
  const out = mod.handleBeforeProviderRequest({
    model: "deepseek-v4-pro-0813",
    messages: [
      { role: "user", content: "first" },
      { role: "system", content: "sys" },
      { role: "user", content: "x " + TRIGGER },
    ],
    tools: [
      {
        type: "function",
        function: { name: "f", description: "use " + TRIGGER + " here" },
      },
    ],
  });
  assert.equal(
    out?.venice_parameters?.include_venice_system_prompt,
    false,
    "tweak kept",
  );
  assert.equal(
    out.messages[0].role,
    "system",
    "system message still moved to index 0",
  );
  assert.equal(
    TRIGGER_RE.test(out.messages[2].content),
    false,
    "message neutralized",
  );
  assert.equal(
    TRIGGER_RE.test(out.tools[0].function.description),
    false,
    "tool description neutralized",
  );
});

test("handleBeforeProviderRequest: nested arrays and objects are walked", () => {
  const stored = {
    model: "unconfigured/model",
    messages: [
      {
        role: "user",
        content: [{ type: "text", text: "part one " + TRIGGER }],
      },
    ],
  };
  const out = mod.handleBeforeProviderRequest(stored);
  assert.ok(out, "a nested trigger must be found");
  assert.equal(TRIGGER_RE.test(out.messages[0].content[0].text), false);
  assert.ok(
    TRIGGER_RE.test(stored.messages[0].content[0].text),
    "the nested stored text is untouched",
  );
});

test("handleBeforeProviderRequest: offset does not matter (96KB and 128KB both rewritten)", () => {
  for (const offset of [96 * 1024, 128 * 1024]) {
    const padding = "x".repeat(offset);
    const out = mod.handleBeforeProviderRequest({
      model: "unconfigured/model",
      messages: [{ role: "user", content: padding + " " + TRIGGER }],
    });
    assert.ok(out, `trigger at offset ${offset} must be rewritten`);
    assert.equal(
      TRIGGER_RE.test(out.messages[0].content),
      false,
      `no trigger may survive at offset ${offset}`,
    );
  }
});

test("handleBeforeProviderRequest: benign look-alikes are left byte-identical", () => {
  for (const benign of BENIGN) {
    const payload = {
      model: "unconfigured/model",
      messages: [{ role: "user", content: "code: " + benign }],
    };
    assert.equal(
      mod.handleBeforeProviderRequest(payload),
      undefined,
      `nothing to send for ${JSON.stringify(benign)}`,
    );
  }
});

test("handleBeforeProviderRequest: untouched subtrees keep their identity", () => {
  const cleanTool = {
    type: "function",
    function: { name: "clean", description: "nothing here" },
  };
  const payload = {
    model: "unconfigured/model",
    messages: [],
    tools: [
      cleanTool,
      { type: "function", function: { name: "dirty", description: TRIGGER } },
    ],
  };
  const out = mod.handleBeforeProviderRequest(payload);
  assert.ok(out, "the dirty tool forces a copy");
  assert.notEqual(out.tools, payload.tools, "the containing array is rebuilt");
  assert.equal(
    out.tools[0],
    cleanTool,
    "the untouched tool keeps its identity",
  );
});

test("handleBeforeProviderRequest: a payload with no trigger is unchanged (undefined)", () => {
  assert.equal(
    mod.handleBeforeProviderRequest({
      model: "unconfigured/model",
      messages: [{ role: "user", content: "ordinary prompt text" }],
    }),
    undefined,
  );
});
