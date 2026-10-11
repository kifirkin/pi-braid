#!/usr/bin/env node
/**
 * failure-translation.test.mjs
 *
 * The failure-class translation seam (packages/providers/failure-translation.ts)
 * pinned against BOTH real classifiers:
 *
 *   - providers `classifyFailure` (ring-lifecycle.ts) answers the fate of the
 *     ROUTE; the module delegates its half to it.
 *   - core `classifyLlmError` (packages/core/src/lib/errors/llm-error.ts)
 *     answers the health of the SESSION; the module mirrors its string path as
 *     data because product code cannot import across the package boundary.
 *
 * Every canonical row asserts three things:
 *   1. `classifyFailure(text)` equals the row's providers verdict;
 *   2. `classifyLlmError(text).category` equals the row's core verdict
 *      (imported through a relative path to the core source, allowed in test
 *      code only, never in the module);
 *   3. `translateFailure(text)` agrees with both classifiers live, so a
 *      change to either classifier, or drift in the module's mirror, is a
 *      red diff rather than a silent translation error.
 *
 * The rows cover every branch either classifier can take for a raw string:
 * empty, the WAF page and the JSON short-circuit, payload/context window,
 * each key-rotation trigger, the 429 carve-out, shape 4xx, 5xx, network
 * idioms, the status-extraction divergences, and the strings whose two
 * verdicts disagree by design (recorded as findings in the change report, not
 * normalized).
 * Core's numeric-status and abort branches need an error object and are
 * unreachable from a string; the "aborted" row documents that boundary.
 *
 * Harness (house pattern): the real modules are compiled with the package's
 * local tsc (CJS emit) into a temp dir and loaded via createRequire. No
 * network; HOME is redirected to an isolated temp dir so a module that reads
 * agent state at load time can never touch the real one.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(here, "..");
const repoRoot = resolve(pkgRoot, "..", "..");
const tscBin = join(pkgRoot, "node_modules", "typescript", "bin", "tsc");

const TSC_FLAGS = [
  "--module",
  "commonjs",
  "--target",
  "ES2022",
  "--lib",
  "ES2022",
  "--strict",
  "--esModuleInterop",
  "--skipLibCheck",
  "--forceConsistentCasingInFileNames",
  "--types",
  "node",
];

function emit(files, outDir) {
  const tsc = spawnSync(
    "node",
    [tscBin, "--ignoreConfig", ...files, "--outDir", outDir, ...TSC_FLAGS],
    { cwd: pkgRoot, encoding: "utf-8" },
  );
  if (tsc.status !== 0) {
    console.error(
      "tsc emit failed:\n" + (tsc.stdout || "") + (tsc.stderr || ""),
    );
    process.exit(1);
  }
}

const buildProviders = mkdtempSync(
  join(tmpdir(), "failure-translation-providers-"),
);
const buildCore = mkdtempSync(join(tmpdir(), "failure-translation-core-"));
const homeDir = mkdtempSync(join(tmpdir(), "failure-translation-home-"));

emit(
  [
    join(pkgRoot, "failure-translation.ts"),
    join(pkgRoot, "ring-lifecycle.ts"),
    join(pkgRoot, "key-ring.ts"),
    join(pkgRoot, "log.ts"),
    join(pkgRoot, "route-state.ts"),
  ],
  buildProviders,
);
emit(
  [join(repoRoot, "packages", "core", "src", "lib", "errors", "llm-error.ts")],
  buildCore,
);

// Redirect HOME before the modules load: nothing in this test creates a ring,
// but the harness stays safe if a module ever reads state at import time.
const OLD_HOME = process.env.HOME;
process.env.HOME = homeDir;

const require = createRequire(import.meta.url);
const mod = require(join(buildProviders, "failure-translation.js"));
const ringLifecycle = require(join(buildProviders, "ring-lifecycle.js"));
const core = require(join(buildCore, "llm-error.js"));

after(() => {
  if (OLD_HOME !== undefined) process.env.HOME = OLD_HOME;
  else delete process.env.HOME;
  rmSync(buildProviders, { recursive: true, force: true });
  rmSync(buildCore, { recursive: true, force: true });
  rmSync(homeDir, { recursive: true, force: true });
});

// The WAF page is assembled from fragments (the house pattern): the source
// carries no complete tag literal, only the shapes the classifier reads.
const LT = "<";
const GT = ">";
const tag = (name, attrs) => LT + name + (attrs ? " " + attrs : "") + GT;
const WAF_HTML_PAGE = [
  tag("!doctype", "html"),
  tag("html"),
  tag("head"),
  tag("title"),
  "edge availability notice",
  tag("/title"),
  tag("/head"),
  tag("body"),
  "403 automated request blocked by waf",
  tag("/body"),
  tag("/html"),
].join("");

/**
 * The pinned table. `class`/`status` are the providers verdict (route fate),
 * `category` is the core verdict (session health), and `why` names the branch
 * or documented precedence the row covers.
 */
const ROWS = [
  {
    text: "",
    class: "none",
    status: null,
    category: "unknown",
    why: "empty string: providers' empty guard; core falls through to unknown",
  },
  {
    text: "   ",
    class: "none",
    status: null,
    category: "unknown",
    why: "whitespace only: providers trims for the empty guard; core trims its text",
  },
  {
    text: "402 Payment Required",
    class: "key",
    status: 402,
    category: "balance",
    why: "quota: 402 named in text",
  },
  {
    text: "402",
    class: "key",
    status: 402,
    category: "balance",
    why: "quota: bare status",
  },
  {
    text: "insufficient_balance",
    class: "key",
    status: null,
    category: "balance",
    why: "quota: insufficient balance idiom",
  },
  {
    text: "billing error",
    class: "key",
    status: null,
    category: "balance",
    why: "quota: billing idiom",
  },
  {
    text: "no quota left",
    class: "key",
    status: null,
    category: "unknown",
    why: "quota: no-quota rotates; core has no bare-quota pattern",
  },
  {
    text: "insufficient credits",
    class: "key",
    status: null,
    category: "unknown",
    why: "quota: credits satisfy providers' insufficient.{credit|balance}; core needs the balance word",
  },
  {
    text: "out of budget",
    class: "key",
    status: null,
    category: "unknown",
    why: "quota: budget idiom rotates; core has no budget pattern",
  },
  {
    text: "usage limit exceeded",
    class: "key",
    status: null,
    category: "unknown",
    why: "spent allowance: subscription/usage cap rotates; core has no allowance pattern",
  },
  {
    text: "you have reached your plan limit",
    class: "key",
    status: null,
    category: "unknown",
    why: "spent allowance: reached + allowance noun + limit",
  },
  {
    text: "plan limit reached",
    class: "key",
    status: null,
    category: "unknown",
    why: "spent allowance: plan limit idiom",
  },
  {
    text: "401 Unauthorized",
    class: "key",
    status: 401,
    category: "auth",
    why: "auth: 401 named in text",
  },
  {
    text: "invalid api key",
    class: "key",
    status: null,
    category: "auth",
    why: "auth: invalid api key idiom",
  },
  {
    text: "403 Forbidden",
    class: "key",
    status: 403,
    category: "unknown",
    why: "forbidden rotates the key; core has no 403 branch",
  },
  {
    text: "403",
    class: "key",
    status: 403,
    category: "unknown",
    why: "forbidden: bare status",
  },
  {
    text: "403 Request blocked by WAF",
    class: "waf",
    status: 403,
    category: "unknown",
    why: "WAF marker without markup",
  },
  {
    text: WAF_HTML_PAGE,
    class: "waf",
    status: 403,
    category: "unknown",
    why: "WAF HTML page: an edge block, never a credential problem",
  },
  {
    text: '{"error":"Request blocked by WAF"}',
    class: "none",
    status: null,
    category: "unknown",
    why: "JSON short-circuit: a JSON body is never a WAF page, and no key pattern fires",
  },
  {
    text: "413 Request Entity Too Large",
    class: "payload",
    status: 413,
    category: "context_window",
    why: "payload: 413 named in text",
  },
  {
    text: "413",
    class: "payload",
    status: 413,
    category: "context_window",
    why: "payload: bare status",
  },
  {
    text: "context_length_exceeded",
    class: "payload",
    status: null,
    category: "context_window",
    why: "payload: context-window idiom",
  },
  {
    text: "context window exceeded",
    class: "payload",
    status: null,
    category: "context_window",
    why: "payload: context-window idiom, spaced form",
  },
  {
    text: "403 context_length_exceeded",
    class: "payload",
    status: 403,
    category: "context_window",
    why: "documented precedence: payload is tested before key, so a size error carrying 403 stays payload",
  },
  {
    text: "429 Too Many Requests",
    class: "none",
    status: 429,
    category: "rate_limit",
    why: "429 carve-out: the walk leaves a plain throttle alone; core owns it",
  },
  {
    text: "429",
    class: "none",
    status: 429,
    category: "rate_limit",
    why: "429 carve-out: bare status",
  },
  {
    text: "rate limit exceeded",
    class: "none",
    status: null,
    category: "rate_limit",
    why: "429 carve-out: throttle wording without a status",
  },
  {
    text: "throttled",
    class: "none",
    status: null,
    category: "rate_limit",
    why: "429 carve-out: throttle idiom",
  },
  {
    text: "429 usage limit exceeded",
    class: "key",
    status: 429,
    category: "rate_limit",
    why: "documented precedence: providers test key before the 429 carve-out; core tests 429 before everything but balance",
  },
  {
    text: "429 rate limit: usage limit exceeded",
    class: "none",
    status: 429,
    category: "rate_limit",
    why: "spent-allowance guard: rate-limit wording wins, so a throttle that also says usage limit stays none",
  },
  {
    text: "400 Bad Request",
    class: "shape",
    status: 400,
    category: "unknown",
    why: "shape: 4xx that is not key and not 429",
  },
  {
    text: "404 Not Found",
    class: "shape",
    status: 404,
    category: "unknown",
    why: "shape: another 4xx; core has no 4xx branch and does not call it transient",
  },
  {
    text: "500 Internal Server Error",
    class: "none",
    status: 500,
    category: "transient",
    why: "5xx: connectivity-class to the walk, retryable to the session",
  },
  {
    text: "502 Bad Gateway",
    class: "none",
    status: 502,
    category: "transient",
    why: "5xx",
  },
  {
    text: "529 overloaded",
    class: "none",
    status: 529,
    category: "transient",
    why: "5xx: the overload status",
  },
  {
    text: "overloaded",
    class: "none",
    status: null,
    category: "transient",
    why: "transient idiom without a status",
  },
  {
    text: "ECONNRESET",
    class: "none",
    status: null,
    category: "transient",
    why: "network reset",
  },
  {
    text: "socket hang up",
    class: "none",
    status: null,
    category: "transient",
    why: "network idiom",
  },
  {
    text: "fetch failed",
    class: "none",
    status: null,
    category: "transient",
    why: "network idiom",
  },
  {
    text: "unknown error",
    class: "none",
    status: null,
    category: "unknown",
    why: "unrecognized text: none to the walk, unknown to the session",
  },
  {
    text: "1429",
    class: "none",
    status: null,
    category: "rate_limit",
    why: "status extraction divergence: core's /429/ matches inside 1429; providers' word-bounded regex names no status",
  },
  {
    text: "aborted",
    class: "none",
    status: null,
    category: "unknown",
    why: "core's abort branch needs an error object; a raw string never reaches it",
  },
];

test("providers classifier still yields the pinned verdict on every row", () => {
  for (const row of ROWS) {
    const verdict = ringLifecycle.classifyFailure(row.text);
    assert.deepEqual(
      verdict,
      { class: row.class, status: row.status },
      `providers verdict for ${JSON.stringify(row.text)} (${row.why})`,
    );
  }
});

test("core classifier still yields the pinned category on every row (cross-check)", () => {
  for (const row of ROWS) {
    const verdict = core.classifyLlmError(row.text);
    assert.equal(
      verdict.category,
      row.category,
      `core category for ${JSON.stringify(row.text)} (${row.why})`,
    );
  }
});

test("translation module agrees with both live classifiers on every row", () => {
  for (const row of ROWS) {
    const translated = mod.translateFailure(row.text);
    const providersVerdict = ringLifecycle.classifyFailure(row.text);
    const coreVerdict = core.classifyLlmError(row.text);
    assert.deepEqual(
      translated,
      {
        class: providersVerdict.class,
        status: providersVerdict.status,
        category: coreVerdict.category,
      },
      `translation for ${JSON.stringify(row.text)} (${row.why})`,
    );
  }
});

test("placement: the module imports nothing from the core package", () => {
  const source = readFileSync(join(pkgRoot, "failure-translation.ts"), "utf8");
  const specifiers = [...source.matchAll(/\bfrom\s+["']([^"']+)["']/g)].map(
    (match) => match[1],
  );
  assert.ok(
    specifiers.length > 0,
    "the module must import its delegated classifier",
  );
  for (const specifier of specifiers) {
    assert.ok(
      !/(^|\/)core(\/|$)|packages\/core/.test(specifier),
      `module must not import core (${specifier})`,
    );
  }
  assert.ok(!/\brequire\s*\(/.test(source), "module must not require anything");
  assert.ok(
    !/\bimport\s*\(/.test(source),
    "module must not use dynamic import",
  );
});
