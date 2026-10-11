/**
 * rate-limiter settings key canonicalization tests.
 *
 * The extension read its limits block from `braid.contrib["rate-limiter"]`,
 * the only hyphenated key in a namespace where every other extension key is
 * camelCase (`networkMonitor`, `browserAdvanced`, `observatory`). The canonical
 * key is now `rateLimiter`; the hyphenated spelling is read as a deprecated
 * alias for one release, with canonical winning when both are present.
 *
 * Gates covered:
 * (a) resolution behavior (pure module, imported directly via node's native
 *     type stripping): canonical resolves, deprecated resolves, canonical
 *     wins on collision, neither yields the built-in defaults, provider
 *     overrides still chain through provider -> global, and a boolean
 *     canonical value (the bundle's extension toggle) never counts as a
 *     config block.
 * (b) the deprecation notice fires once and names both spellings.
 * (c) revert-proof source contract: the hyphenated key is read in settings.ts
 *     only, index.ts wires the resolver, and index.ts itself no longer reads
 *     the deprecated key.
 *
 * Run: node test/runtime/contrib/test-rate-limiter-settings-alias.mjs
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const RATE_LIMITER = join(HERE, "..", "..", "..", "..", "contrib", "rate-limiter");
const SETTINGS_TS = join(RATE_LIMITER, "settings.ts");
const INDEX_TS = join(RATE_LIMITER, "index.ts");

assert.ok(existsSync(SETTINGS_TS), `settings.ts not found at ${SETTINGS_TS}`);
assert.ok(existsSync(INDEX_TS), `index.ts not found at ${INDEX_TS}`);

const settingsSource = readFileSync(SETTINGS_TS, "utf-8");
const indexSource = readFileSync(INDEX_TS, "utf-8");

const {
  CANONICAL_KEY,
  DEPRECATED_KEY,
  DEFAULT_LIMITS,
  deprecationNotice,
  createSettingsResolver,
  resolveRateLimiterSettings,
} = await import(pathToFileURL(SETTINGS_TS).href);

const wrap = (contrib) => ({ braid: { contrib } });

// ── (a) resolution behavior ─────────────────────────────────────────────

describe("resolveRateLimiterSettings", () => {
  it("uses the canonical camelCase key", () => {
    const r = resolveRateLimiterSettings(wrap({ rateLimiter: { rpm: 7, tpm: 900 } }));
    assert.equal(r.source, "canonical");
    assert.equal(r.global.rpm, 7);
    assert.equal(r.global.tpm, 900);
  });

  it("still resolves the deprecated hyphenated key (one release)", () => {
    const r = resolveRateLimiterSettings(wrap({ "rate-limiter": { rpm: 11, tpm: 1300 } }));
    assert.equal(r.source, "deprecated");
    assert.equal(r.global.rpm, 11);
    assert.equal(r.global.tpm, 1300);
  });

  it("canonical wins when both spellings are present", () => {
    const r = resolveRateLimiterSettings(
      wrap({
        rateLimiter: { rpm: 1, tpm: 2 },
        "rate-limiter": { rpm: 999, tpm: 999 },
      }),
    );
    assert.equal(r.source, "canonical");
    assert.equal(r.global.rpm, 1);
    assert.equal(r.global.tpm, 2);
  });

  it("falls back to the built-in defaults when neither key is set", () => {
    for (const raw of [wrap({}), wrap({ networkMonitor: { probeIntervalMs: 5 } }), {}, null, undefined]) {
      const r = resolveRateLimiterSettings(raw);
      assert.equal(r.source, "default");
      assert.deepEqual(r.global, DEFAULT_LIMITS.default);
      assert.deepEqual(r.providers, {});
    }
    assert.equal(DEFAULT_LIMITS.default.rpm, 30);
    assert.equal(DEFAULT_LIMITS.default.tpm, 500_000);
  });

  it("treats a boolean canonical value as the extension toggle, not a config block", () => {
    // The bundle toggle and the config block share the camelCase spelling.
    const asToggle = resolveRateLimiterSettings(wrap({ rateLimiter: true }));
    assert.equal(asToggle.source, "default");
    assert.deepEqual(asToggle.global, DEFAULT_LIMITS.default);

    // A boolean canonical must not shadow a hyphenated config block either.
    const both = resolveRateLimiterSettings(
      wrap({ rateLimiter: true, "rate-limiter": { rpm: 42 } }),
    );
    assert.equal(both.source, "deprecated");
    assert.equal(both.global.rpm, 42);
  });

  it("keeps the provider -> built-in -> global fallback chain", () => {
    const r = resolveRateLimiterSettings(
      wrap({
        rateLimiter: {
          rpm: 5,
          tpm: 600,
          providers: {
            anthropic: { rpm: 9 }, // tpm falls to the built-in anthropic default
            custom: { rpm: 3, tpm: 4 }, // no built-in -> block global values
            unknown: {}, // empty -> built-ins for an unknown provider -> global
          },
        },
      }),
    );
    assert.equal(r.providers.anthropic.rpm, 9);
    assert.equal(r.providers.anthropic.tpm, DEFAULT_LIMITS.anthropic.tpm);
    assert.deepEqual(r.providers.custom, { rpm: 3, tpm: 4 });
    assert.deepEqual(r.providers.unknown, { rpm: 5, tpm: 600 });
  });

  it("ignores malformed provider entries and non-numeric fields", () => {
    const r = resolveRateLimiterSettings(
      wrap({ rateLimiter: { rpm: "fast", providers: { bad: 7, ok: { rpm: 8 } } } }),
    );
    assert.equal(r.global.rpm, DEFAULT_LIMITS.default.rpm);
    assert.equal("bad" in r.providers, false);
    assert.equal(r.providers.ok.rpm, 8);
  });
});

// ── (b) deprecation notice fires once ───────────────────────────────────

describe("deprecation notice", () => {
  it("names both spellings and the removal release", () => {
    const notice = deprecationNotice();
    assert.ok(notice.includes(DEPRECATED_KEY), "notice must name the deprecated key");
    assert.ok(notice.includes(CANONICAL_KEY), "notice must name the canonical key");
    assert.match(notice, /removed after this release/);
  });

  it("fires once per process, and only on the deprecated path", () => {
    const seen = [];
    const resolve = createSettingsResolver((msg) => seen.push(msg));

    resolve(wrap({ "rate-limiter": { rpm: 1 } }));
    resolve(wrap({ "rate-limiter": { rpm: 2 } }));
    resolve(wrap({ rateLimiter: { rpm: 3 } }));
    resolve(wrap({}));

    assert.equal(seen.length, 1, "the deprecation warning must fire exactly once");
    assert.equal(seen[0], deprecationNotice());
  });

  it("never warns on the canonical path", () => {
    const seen = [];
    const resolve = createSettingsResolver((msg) => seen.push(msg));
    resolve(wrap({ rateLimiter: { rpm: 1 } }));
    assert.deepEqual(seen, []);
  });
});

// ── (c) revert-proof source contract ────────────────────────────────────

describe("source contract", () => {
  it("reads the hyphenated key in settings.ts only", () => {
    assert.ok(
      /contrib\[DEPRECATED_KEY\]/.test(settingsSource),
      "settings.ts must read the deprecated key (alias kept for one release)",
    );
    assert.ok(
      !/rate-limiter"\]/.test(indexSource),
      "index.ts must not read the deprecated key directly; resolution lives in settings.ts",
    );
  });

  it("wires index.ts through the once-only resolver", () => {
    assert.ok(
      indexSource.includes("createSettingsResolver"),
      "index.ts must build its resolver with createSettingsResolver (warn-once)",
    );
    assert.ok(
      indexSource.includes("resolveSettings(raw)"),
      "loadLimits must resolve through the injected resolver, not inline key reads",
    );
  });

  it("no longer declares its own defaults or config type inline", () => {
    assert.ok(
      !/const DEFAULT_LIMITS/.test(indexSource),
      "DEFAULT_LIMITS belongs to settings.ts (single source, schema-derivable)",
    );
    assert.ok(
      !/interface RateLimitConfig/.test(indexSource),
      "RateLimitConfig belongs to settings.ts",
    );
  });
});
