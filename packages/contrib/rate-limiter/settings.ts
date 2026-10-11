/**
 * Rate limiter settings resolution (`braid.contrib` in settings.json).
 *
 * The canonical key is camelCase (`rateLimiter`), matching every other
 * contrib extension key (`networkMonitor`, `browserAdvanced`, `observatory`).
 * The hyphenated spelling (`rate-limiter`) is a deprecated alias: it is read
 * for one release, canonical wins when both are present, and using it emits a
 * once-per-process notice.
 *
 * Pure module: no pi imports and no file IO. The caller passes the parsed
 * settings document, so resolution (and the deprecation path) is testable
 * without touching the live settings file.
 */

export interface RateLimitConfig {
  rpm: number;
  tpm: number;
}

/** Which key supplied the limits block. */
export type SettingsSource = "canonical" | "deprecated" | "default";

export interface RateLimiterSettings {
  global: RateLimitConfig;
  providers: Record<string, RateLimitConfig>;
  source: SettingsSource;
}

export const CANONICAL_KEY = "rateLimiter";
export const DEPRECATED_KEY = "rate-limiter";

/** Built-in ceilings per provider, and the global fallback. */
export const DEFAULT_LIMITS: Record<string, RateLimitConfig> = {
  default: { rpm: 30, tpm: 500_000 },
  anthropic: { rpm: 50, tpm: 200_000 },
  openai: { rpm: 500, tpm: 800_000 },
  google: { rpm: 60, tpm: 400_000 },
  groq: { rpm: 30, tpm: 150_000 },
};

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A number if the value is one, otherwise the fallback. */
function pickNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/**
 * Which spelling supplies the limits block. A non-object value never counts:
 * the camelCase key also carries the bundle's boolean extension toggle, so a
 * `rateLimiter: true` must not be mistaken for an empty config block.
 */
function pickBlock(raw: unknown): { block: unknown; source: SettingsSource } {
  const contrib = (raw as { braid?: { contrib?: unknown } } | null)?.braid
    ?.contrib;
  if (!isObject(contrib)) return { block: undefined, source: "default" };
  const canonical = contrib[CANONICAL_KEY];
  if (isObject(canonical)) return { block: canonical, source: "canonical" };
  const deprecated = contrib[DEPRECATED_KEY];
  if (isObject(deprecated)) return { block: deprecated, source: "deprecated" };
  return { block: undefined, source: "default" };
}

/**
 * Resolve the RPM/TPM limits from a parsed settings document. A missing or
 * unshaped block yields the built-in global defaults and no provider
 * overrides, exactly as an unset key always did.
 */
export function resolveRateLimiterSettings(raw: unknown): RateLimiterSettings {
  const { block, source } = pickBlock(raw);
  if (!isObject(block)) {
    return { global: DEFAULT_LIMITS.default, providers: {}, source: "default" };
  }
  const global: RateLimitConfig = {
    rpm: pickNumber(block.rpm, DEFAULT_LIMITS.default.rpm),
    tpm: pickNumber(block.tpm, DEFAULT_LIMITS.default.tpm),
  };
  const providers: Record<string, RateLimitConfig> = {};
  if (isObject(block.providers)) {
    for (const [provider, limits] of Object.entries(block.providers)) {
      if (!isObject(limits)) continue;
      providers[provider] = {
        rpm: pickNumber(
          limits.rpm,
          DEFAULT_LIMITS[provider]?.rpm ?? global.rpm,
        ),
        tpm: pickNumber(
          limits.tpm,
          DEFAULT_LIMITS[provider]?.tpm ?? global.tpm,
        ),
      };
    }
  }
  return { global, providers, source };
}

/** The deprecation notice, naming both spellings and the removal release. */
export function deprecationNotice(): string {
  return (
    `braid.contrib["${DEPRECATED_KEY}"] is deprecated and will be removed after this ` +
    `release; use braid.contrib.${CANONICAL_KEY}.`
  );
}

/**
 * Wrap `resolveRateLimiterSettings` with a one-time deprecation notice: the
 * warning fires on the first resolution that reads the deprecated key and
 * never again in the process. The sink is injected so the extension logs
 * through its own logger and a test can count the calls.
 */
export function createSettingsResolver(
  warn: (message: string) => void,
): (raw: unknown) => RateLimiterSettings {
  let warned = false;
  return (raw: unknown): RateLimiterSettings => {
    const settings = resolveRateLimiterSettings(raw);
    if (settings.source === "deprecated" && !warned) {
      warned = true;
      warn(deprecationNotice());
    }
    return settings;
  };
}
