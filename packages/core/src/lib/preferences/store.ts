/**
 * The preference store: standing owner rules, filed by the surface they govern.
 *
 * A standing preference is a rule that must fire at a specific moment, and the
 * memory stores reach the prompt by association rather than by trigger: a rule
 * about button labels surfaces when an incoming message happens to resemble it.
 * This module is the store half of the fix - one JSON file, one entry per rule,
 * and a `surface` field naming the thing that has to be in play for the rule to
 * apply. The prompt builder renders the entries whose surface the session can
 * reach; the checker holds the file and its rendered projection to one content.
 *
 * Two decisions are worth naming here.
 *
 * The version is checked before anything else, and an unknown version is
 * returned as an error rather than as zero preferences. A store written by a
 * later build can carry a field this build would drop, and a store read only
 * halfway is worse than a missing one: the reader that cannot understand the
 * file says so, and its caller decides what to do with the refusal.
 *
 * An entry that does not parse is never dropped silently. It is counted with
 * the reason it failed, so a rule the owner wrote either reaches the prompt or
 * appears in a report saying why it did not.
 *
 * Nothing here knows what a surface is. The vocabulary belongs to the prompt
 * builder, which is the only place that can answer whether a surface is in play
 * this session. This module holds shape, path and version only.
 */
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { braidDir } from "../config/braid-paths.js";

/** The store version this build reads and writes. */
export const PREFERENCES_VERSION = 1;

/** Store filename under the braid home. */
export const PREFERENCES_FILE = "preferences.json";

/**
 * Rendered projection of the same store. A view for a human reader, never a
 * second truth: the checker refuses a file that says something the store does
 * not, in either direction.
 */
export const PREFERENCES_DOC_FILE = "preferences.md";

/** Store path, resolved on every call so a pinned root follows BRAID_HOME. */
export function preferencesFilePath(): string {
  return path.join(braidDir(), PREFERENCES_FILE);
}

/** Rendered-projection path, resolved the same way as the store's. */
export function preferencesDocPath(): string {
  return path.join(braidDir(), PREFERENCES_DOC_FILE);
}

/**
 * One standing rule.
 *
 * `surface` names what has to be in play for the rule to apply; the prompt
 * builder owns that vocabulary. A missing, null or blank surface means the rule
 * is bound to nothing, which has to be declared with `unbound: true`: a rule
 * nothing can fire is an honest state, and an undeclared one is an omission that
 * looks like a surface. The checker refuses the undeclared form.
 */
export interface PreferenceEntry {
  readonly id: string;
  readonly surface: string | null;
  readonly rule: string;
  /** The day the rule began applying; a timestamp is accepted for its date part. */
  readonly since: string;
  readonly source: string;
  readonly unbound?: boolean;
  /** Ids of rules this one cannot hold alongside, when the contradiction is declared. */
  readonly contradicts?: readonly string[];
  readonly examples?: readonly string[];
}

/** An entry the reader could not use, with the reason it was dropped. */
export interface PreferenceRejection {
  /** Position in the store's `entries` array, so the author can find the row. */
  readonly index: number;
  /** The entry's id when it carried a readable one; otherwise the index is the handle. */
  readonly id: string | null;
  readonly reason: string;
}

/**
 * A store read: the usable entries with the unusable ones beside them, or the
 * refusal that stopped the read. A missing file is not a refusal - it reads as
 * no entries, which is the same state as a store nobody has written yet.
 */
export type PreferencesRead =
  | {
      readonly ok: true;
      readonly path: string;
      readonly version: number;
      readonly entries: readonly PreferenceEntry[];
      readonly rejected: readonly PreferenceRejection[];
    }
  | { readonly ok: false; readonly path: string; readonly error: string };

/** Refusal text for an unreadable store, shared by every caller that reports one. */
export function describeStoreRefusal(read: PreferencesRead): string | null {
  return read.ok ? null : `${read.path}: ${read.error}`;
}

/** A date, or an ISO timestamp whose date part is the day the rule began. */
const SINCE_DATE = /^(\d{4})-(\d{2})-(\d{2})(?:T[\d:.]+(?:Z|[+-]\d{2}:?\d{2})?)?$/;

/**
 * The date a `since` value names, or null when the value is not a date.
 *
 * A timestamp is accepted because a caller writing the store from a log has one
 * to hand; the calendar day is all a preference needs, and rendering keeps only
 * that part so the two spellings of one day cannot read as a change.
 */
export function sinceDate(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const match = SINCE_DATE.exec(value.trim());
  return match === null ? null : `${match[1]}-${match[2]}-${match[3]}`;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

function isStringList(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((item) => isNonEmptyString(item));
}

type EntryCheck =
  | { readonly ok: true; readonly entry: PreferenceEntry }
  | { readonly ok: false; readonly rejection: PreferenceRejection };

/**
 * Validate one entry. Every failure carries the reason, because the count alone
 * tells an author that a rule was lost and not which one or why.
 */
function checkEntry(raw: unknown, index: number): EntryCheck {
  const fail = (reason: string, id: string | null = null): EntryCheck => ({
    ok: false,
    rejection: { index, id, reason },
  });
  if (!isPlainObject(raw)) return fail("entry is not an object");
  const id = isNonEmptyString(raw.id) ? raw.id.trim() : null;
  if (id === null) return fail('missing "id"');
  if (!isNonEmptyString(raw.rule)) return fail('missing "rule"', id);
  if (sinceDate(raw.since) === null) {
    return fail(
      isNonEmptyString(raw.since)
        ? `"since" is not a date: ${raw.since.trim()}`
        : 'missing "since"',
      id,
    );
  }
  if (!isNonEmptyString(raw.source)) return fail('missing "source"', id);
  const surface = raw.surface === undefined || raw.surface === null ? null : raw.surface;
  if (surface !== null && typeof surface !== "string") {
    return fail('"surface" is not a string', id);
  }
  if (raw.unbound !== undefined && typeof raw.unbound !== "boolean") {
    return fail('"unbound" is not a boolean', id);
  }
  if (raw.contradicts !== undefined && !isStringList(raw.contradicts)) {
    return fail('"contradicts" is not a list of ids', id);
  }
  if (raw.examples !== undefined && !isStringList(raw.examples)) {
    return fail('"examples" is not a list of strings', id);
  }
  const entry: PreferenceEntry = {
    id,
    surface: surface === null ? null : surface.trim(),
    rule: raw.rule.trim(),
    since: String(raw.since).trim(),
    source: raw.source.trim(),
    ...(raw.unbound === undefined ? {} : { unbound: raw.unbound }),
    ...(raw.contradicts === undefined ? {} : { contradicts: raw.contradicts }),
    ...(raw.examples === undefined ? {} : { examples: raw.examples }),
  };
  return { ok: true, entry };
}

/**
 * Read the store. `filePath` defaults to the live path; the override is for the
 * gate, which reads what the caller points at and nothing else.
 */
export function readPreferences(filePath: string = preferencesFilePath()): PreferencesRead {
  let source: string;
  try {
    source = readFileSync(filePath, "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
      return { ok: true, path: filePath, version: PREFERENCES_VERSION, entries: [], rejected: [] };
    }
    return { ok: false, path: filePath, error: `cannot be read: ${errorMessage(error)}` };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch (error) {
    return { ok: false, path: filePath, error: `is not JSON: ${errorMessage(error)}` };
  }
  if (!isPlainObject(parsed)) {
    return { ok: false, path: filePath, error: "top level is not an object" };
  }

  const version = parsed.version;
  if (typeof version !== "number" || !Number.isInteger(version)) {
    return {
      ok: false,
      path: filePath,
      error: `declares no version; this build reads version ${PREFERENCES_VERSION}`,
    };
  }
  if (version !== PREFERENCES_VERSION) {
    return {
      ok: false,
      path: filePath,
      error: `declares version ${version}; this build reads version ${PREFERENCES_VERSION}`,
    };
  }
  if (!Array.isArray(parsed.entries)) {
    return { ok: false, path: filePath, error: 'has no "entries" array' };
  }

  const entries: PreferenceEntry[] = [];
  const rejected: PreferenceRejection[] = [];
  const seen = new Map<string, number>();
  for (let index = 0; index < parsed.entries.length; index++) {
    const checked = checkEntry(parsed.entries[index], index);
    if (!checked.ok) {
      rejected.push(checked.rejection);
      continue;
    }
    const firstIndex = seen.get(checked.entry.id);
    if (firstIndex !== undefined) {
      rejected.push({
        index,
        id: checked.entry.id,
        reason: `duplicate id "${checked.entry.id}", already read at entry ${firstIndex}`,
      });
      continue;
    }
    seen.set(checked.entry.id, index);
    entries.push(checked.entry);
  }
  return { ok: true, path: filePath, version, entries, rejected };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
