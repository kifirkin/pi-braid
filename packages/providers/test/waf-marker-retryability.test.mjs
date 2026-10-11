// waf-marker-retryability.test.mjs — the first-block WAF retry marker must
// actually flip pi-core's retry classification.
//
// pi-core decides the turn retry on the REPLACED message: the message_end
// handler result is applied in place, then agent-session classifies it with
// isRetryableAssistantError. For an edge/WAF block the raw page text is
// replaced by sanitizeWafError() before the marker is appended, so the
// classifier never sees provider text — the marker text itself is the only
// carrier of the retry phrase. A marker whose wording lacks the phrase leaves
// the stored composite classified non-retryable and the promised same-route
// retry never happens.
//
// Classifier under test: isRetryableAssistantError from
// @earendil-works/pi-ai/utils/retry (dist/utils/retry.js) — the module
// pi-core imports through pi-ai/compat in agent-session.
//
// Marker constants are PARSED FROM ring-lifecycle.ts source and checked equal
// to the compiled exports, so the verdicts below always describe the shipped
// text rather than a copy of it.
//
// House pattern: compile ring-lifecycle with the package's local tsc (CJS
// emit) into a temp dir, load via createRequire. HOME is redirected to an
// isolated temp dir. No network.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isRetryableAssistantError } from "@earendil-works/pi-ai/utils/retry";

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(here, "..");
const tscBin = join(pkgRoot, "node_modules", "typescript", "bin", "tsc");

const buildDir = mkdtempSync(join(tmpdir(), "waf-marker-build-"));
const homeDir = mkdtempSync(join(tmpdir(), "waf-marker-home-"));
const tsc = spawnSync(
  "node",
  [
    tscBin,
    "--ignoreConfig",
    join(pkgRoot, "ring-lifecycle.ts"),
    join(pkgRoot, "key-ring.ts"),
    join(pkgRoot, "log.ts"),
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
// AGENT_ZERO_API_KEY_P* (which the real setup may export) must be gone first.
for (const key of Object.keys(process.env)) {
  if (/^AGENT_ZERO_API_KEY(_P\d+)?$/.test(key)) delete process.env[key];
}
const OLD_HOME = process.env.HOME;
process.env.HOME = homeDir;

const require = createRequire(import.meta.url);
const mod = require(join(buildDir, "ring-lifecycle.js"));

after(() => {
  if (OLD_HOME !== undefined) process.env.HOME = OLD_HOME;
  else delete process.env.HOME;
  rmSync(buildDir, { recursive: true, force: true });
  rmSync(homeDir, { recursive: true, force: true });
});

// The shipped marker text, read from source. Never a typed literal.
const marker = (() => {
  const src = readFileSync(join(pkgRoot, "ring-lifecycle.ts"), "utf8");
  const literal = (name) => {
    const match = new RegExp(`export const ${name} =\\s*"([^"]*)"`).exec(src);
    assert.ok(
      match,
      `${name}: ring-lifecycle.ts must declare it as a plain string literal`,
    );
    return match[1];
  };
  return {
    waf: literal("WAF_RETRY_MARKER"),
    wafRepeat: literal("WAF_REPEAT_RETRY_MARKER"),
    selfHeal: literal("SELF_HEAL_RETRY_MARKER"),
  };
})();

// Runtime-assembled markup shape: the source holds only innocuous fragments,
// never a complete tag literal.
const LT = "<";
const GT = ">";
const tag = (name, attrs) => LT + name + (attrs ? " " + attrs : "") + GT;
const BLOCK_PAGE = [
  tag("!doctype", "html"),
  tag("html"),
  tag("head"),
  tag("title"),
  "edge availability notice",
  tag("/title"),
  tag("/head"),
  tag("body"),
  "automated request blocked by " + "waf",
  tag("img", 'src="data:image/png;base64,' + "c3ludGhldGlj" + '"'),
  tag("/body"),
  tag("/html"),
].join("");

const wafMessage = (errorMessage) => ({
  role: "assistant",
  provider: "agent-zero",
  model: "deepseek-v4-pro-0813",
  stopReason: "error",
  errorMessage,
  content: [],
  usage: {},
  timestamp: 0,
});

test("marker constants parsed from source are the compiled exports", () => {
  assert.equal(marker.waf, mod.WAF_RETRY_MARKER);
  assert.equal(marker.wafRepeat, mod.WAF_REPEAT_RETRY_MARKER);
  assert.equal(marker.selfHeal, mod.SELF_HEAL_RETRY_MARKER);
});

test("the first-block marker alone is retryable by the installed classifier", () => {
  assert.equal(
    isRetryableAssistantError(wafMessage(marker.waf)),
    true,
    "the marker text must carry the retry phrase pi-ai keys on; pi-core classifies this text, not the raw page",
  );
});

test("the stored first-block composite is retryable", () => {
  const result = mod.handleMessageEnd({ message: wafMessage(BLOCK_PAGE) });
  assert.ok(result, "a WAF block must return a replacement message");
  // The exact string pi-core stores and then classifies: sanitized text plus
  // the marker, with zero raw page text surviving.
  assert.equal(
    result.message.errorMessage,
    `${mod.sanitizeWafError(BLOCK_PAGE)}${mod.WAF_RETRY_MARKER}`,
  );
  assert.equal(
    result.message.errorMessage.includes("edge availability notice"),
    false,
    "raw page text must be gone before the classifier sees the message",
  );
  assert.equal(
    isRetryableAssistantError(result.message),
    true,
    "the stored composite must classify as retryable or the same-route retry never fires",
  );
});

test("the production wiring (rotation hooks, first block) stores the retryable composite", () => {
  // index.ts always passes rotation hooks; noteWafBlock() false is the first
  // block of an episode, which is the branch that keeps the same-route marker.
  const hooks = {
    rotation: {
      noteWafBlock: () => false,
      onRingExhausted: () => null,
    },
  };
  const result = mod.handleMessageEnd(
    { message: wafMessage(BLOCK_PAGE) },
    hooks,
  );
  assert.ok(result, "a WAF block must return a replacement message");
  assert.equal(isRetryableAssistantError(result.message), true);
});

test("the phrase must live in the marker: page and sanitized text alone stay non-retryable", () => {
  // Neither carrier is retryable on its own, so the marker is the only place
  // the retry phrase can come from — the mechanism the wording must honor.
  assert.equal(isRetryableAssistantError(wafMessage(BLOCK_PAGE)), false);
  assert.equal(
    isRetryableAssistantError(wafMessage(mod.sanitizeWafError(BLOCK_PAGE))),
    false,
  );
});

test("the sibling markers stay retryable", () => {
  assert.equal(isRetryableAssistantError(wafMessage(marker.wafRepeat)), true);
  assert.equal(isRetryableAssistantError(wafMessage(marker.selfHeal)), true);
});

test("a fatal account token still suppresses the marker and stays non-retryable", () => {
  const fatal = BLOCK_PAGE + tag("p") + "insufficient_quota" + tag("/p");
  const result = mod.handleMessageEnd({ message: wafMessage(fatal) });
  assert.ok(result, "a non-retryable WAF block must still be sanitized");
  assert.equal(result.message.errorMessage, mod.sanitizeWafError(fatal));
  assert.equal(isRetryableAssistantError(result.message), false);
});
