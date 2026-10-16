/**
 * `braid.contrib.<name>` off switch, read by each contrib extension's factory.
 *
 * The bundle entry (index.ts) gates modules while loading them, but pi loads
 * the `pi.extensions` entries directly and never executes the bundle, so the
 * same `false` has to work at the module's own factory — that is what this
 * helper is for. The three modules with a richer settings block
 * (`browserAdvanced`, `observatory.record`, `pathSecurity.block`) keep their
 * own readers; they read the same key shapes and are unaffected.
 *
 * Contract, shared with the bundle's own reader:
 *   - a literal `false` disables; an absent key, `true`, or any other value
 *     leaves the module enabled;
 *   - a missing or unparseable settings.json reads as enabled (fail open) —
 *     a broken file must not silently remove tools from a session.
 *
 * The deprecated `rate-limiter` spelling is accepted for its one-release
 * window: pass both spellings as `rate-limiter/settings.ts` spells them,
 * canonical first. The first spelling present in the document decides, so a
 * canonical `true` outvotes a stale deprecated `false` — the same precedence
 * the limits resolver applies to the two blocks.
 */

import { readSettingsFileOutcome } from "pi-braid/lib";

export interface ToggleVerdict {
  /** True only for a literal `false` under one of the accepted spellings. */
  disabled: boolean;
  /** The spelling the verdict consulted: the one present, else the canonical key. */
  key: string;
}

/**
 * Decide from a parsed settings document whether a module is disabled.
 *
 * `keys` is in precedence order: the first key present in `braid.contrib`
 * supplies the verdict. A `braid.contrib` that is absent or not an object
 * leaves every module enabled.
 */
export function toggleVerdict(
  document: unknown,
  keys: readonly string[],
): ToggleVerdict {
  const contrib = (
    document as { braid?: { contrib?: unknown } } | null | undefined
  )?.braid?.contrib;
  if (typeof contrib !== "object" || contrib === null) {
    return { disabled: false, key: keys[0] };
  }
  const block = contrib as Record<string, unknown>;
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(block, key)) {
      return { disabled: block[key] === false, key };
    }
  }
  return { disabled: false, key: keys[0] };
}

/**
 * Live verdict for a module, read through pi's agent directory
 * (`PI_CODING_AGENT_DIR`-aware) on every call: the factory reads once at load,
 * which is the only cadence the toggle has ever had.
 */
export function readToggleVerdict(keys: readonly string[]): ToggleVerdict {
  return toggleVerdict(readSettingsFileOutcome().settings, keys);
}
