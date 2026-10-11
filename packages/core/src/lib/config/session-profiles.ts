/**
 * Session profiles — cwd-routed session classification.
 *
 * A profile is `{ name, cwd, hint? }`. One lookup answers two questions:
 * which profile owns a session's working directory, and whether that
 * profile carries a first-turn hint — a one-shot steer the skills tool
 * delivers on the session's first non-empty prompt. No role names are
 * compiled in: the mapping is data, so the same build serves any
 * deployment.
 *
 * Config home: the braid config file (getBraidConfigFilePath()), a file
 * braid owns and reads fresh per session start. Shape:
 *
 *   {
 *     "sessionProfiles": [
 *       { "name": "alpha", "cwd": "~/workspace/a", "hint": "…" },
 *       { "name": "beta", "cwd": "~/projects" }
 *     ]
 *   }
 *
 * Rules:
 *  - First match wins (array order); a match is the profile cwd itself or
 *    any directory under it. `~` and `~/…` expand against HOME.
 *  - `cwd` must be absolute after expansion; relative entries are dropped.
 *  - `name` must pass the profile-name gate; `hint`, when present, must be
 *    a non-empty string. An entry failing either shape is dropped whole —
 *    a half-applied profile could classify or steer the wrong session.
 *  - No match, no file, or unreadable config → the neutral default profile,
 *    which carries no hint.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, relative, resolve } from "node:path";
import { createLogger } from "../core/logger.js";
import { getBraidConfigFilePath } from "./braid-paths.js";

const log = createLogger("session-profiles");

/**
 * Neutral default for sessions that match no configured profile. The
 * monthly adoption rollup excludes this bucket. Spelled "other" so
 * pre-profile adoption records keep folding under the same name.
 */
export const NEUTRAL_SESSION_PROFILE = "other";

/** One configured cwd → profile rule (validated, HOME-expanded). */
export interface SessionProfileRule {
  name: string;
  /** Absolute directory this profile owns. */
  cwd: string;
  /** One-shot first-turn steer text; absent → this profile never hints. */
  hint?: string;
}

/** The effective profile of one session. */
export interface ResolvedSessionProfile {
  name: string;
  hint?: string;
}

/**
 * Profile-name gate, shared by config validation and telemetry
 * normalization: 1..64 chars of `[A-Za-z0-9._-]`, starting alphanumeric.
 * Missing, non-string, empty, and malformed values all read as unknown.
 */
export function normalizeProfileName(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const name = raw.trim();
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name) ? name : undefined;
}

/** Expand a leading `~` (bare or `~/…`) against home; other paths unchanged. */
export function expandHomePath(p: string, home: string = homedir()): string {
  if (p === "~") return home;
  if (p.startsWith("~/")) return resolve(home, p.slice(2));
  return p;
}

/** True when `cwd` is `root` itself or anywhere inside it. */
function isUnder(root: string, cwd: string): boolean {
  const rel = relative(root, cwd);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** Validate one raw entry; undefined when the entry must be dropped. */
export function parseSessionProfile(raw: unknown): SessionProfileRule | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const entry = raw as Record<string, unknown>;
  const name = normalizeProfileName(entry.name);
  if (!name) return undefined;
  if (typeof entry.cwd !== "string" || !entry.cwd.trim()) return undefined;
  const expanded = expandHomePath(entry.cwd.trim());
  if (!isAbsolute(expanded)) return undefined;
  if (entry.hint !== undefined && (typeof entry.hint !== "string" || !entry.hint.trim())) {
    return undefined;
  }
  const rule: SessionProfileRule = { name, cwd: resolve(expanded) };
  if (typeof entry.hint === "string") rule.hint = entry.hint;
  return rule;
}

/** Parse a whole `sessionProfiles` array; non-array/junk input → no rules. */
export function parseSessionProfiles(raw: unknown): SessionProfileRule[] {
  if (!Array.isArray(raw)) return [];
  const rules: SessionProfileRule[] = [];
  for (const entry of raw) {
    const rule = parseSessionProfile(entry);
    if (rule) rules.push(rule);
  }
  return rules;
}

/** Warned once per process about invalid config entries (log-once pattern). */
let _warnedInvalidProfiles = false;

/** Read the profile rules from the braid config home, fresh per call. */
export function readSessionProfiles(
  filePath: string = getBraidConfigFilePath(),
): SessionProfileRule[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(filePath, "utf-8"));
  } catch {
    return []; // missing, unreadable, or malformed config → no profiles
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return [];
  const raw = (parsed as Record<string, unknown>).sessionProfiles;
  if (raw === undefined) return [];
  const rules = parseSessionProfiles(raw);
  const rawCount = Array.isArray(raw) ? raw.length : 0;
  if (rules.length < rawCount && !_warnedInvalidProfiles) {
    _warnedInvalidProfiles = true;
    log.warn(
      `Ignoring ${rawCount - rules.length} invalid braid session profile(s): each entry ` +
        "needs a name, an absolute (or ~-prefixed) cwd, and a non-empty hint when set.",
    );
  }
  return rules;
}

/** Resolve a cwd against a profile list. Pure; first match wins. */
export function resolveSessionProfile(
  cwd: string | undefined | null,
  profiles: SessionProfileRule[],
): ResolvedSessionProfile {
  if (cwd) {
    const resolved = resolve(cwd);
    for (const profile of profiles) {
      if (isUnder(profile.cwd, resolved)) {
        return profile.hint !== undefined
          ? { name: profile.name, hint: profile.hint }
          : { name: profile.name };
      }
    }
  }
  return { name: NEUTRAL_SESSION_PROFILE };
}

/** Resolve the effective profile for a session cwd, reading config fresh. */
export function resolveSessionProfileForCwd(
  cwd: string | undefined | null,
): ResolvedSessionProfile {
  return resolveSessionProfile(cwd, readSessionProfiles());
}
