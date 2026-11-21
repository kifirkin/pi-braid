/**
 * Versioned on-disk stores: one rule, two readers.
 *
 * A store that carries no version is a file whose reader has to guess. The
 * guess is never written down, so it cannot be reviewed, and the day the format
 * changes the reader that defaulted a missing field and the reader that threw
 * on an old row are both behaving exactly as they were written. This module is
 * the alternative: every store states the version of its contents, a reader
 * states the versions it can read, and a mismatch is a refusal that names the
 * file, the version found and the versions supported.
 *
 * Two shapes, one rule:
 *
 *   readVersionedJson      one document with a top-level `version`
 *   readVersionedJsonl     one record per line, versioned by declaration
 *
 * A JSON document can carry its own version, so an unknown one stops the read.
 * A JSONL file cannot (a header would have to be invented, and every existing
 * row would have to be rewritten to add it), so the caller declares the row
 * version it expects and each row may declare its own. The file-level rule
 * still applies to that declaration: a caller that declares a row version this
 * reader does not support is refused before a byte is read, because that is a
 * wiring error rather than a data problem.
 *
 * Within that rule, a malformed row is a count, never an exception. A file is
 * read for what it holds, and one torn line from a crash must not cost the
 * caller the other nine hundred. So a line that does not parse, a row missing a
 * declared required field, a row at a version this reader does not support, and
 * a row missing a declared optional field are four counted classes, each with
 * its line number. The four counts plus the rows returned add up to the file's
 * line count; that identity is the guarantee that nothing was skipped in
 * silence.
 *
 * A versionless file is refused unless the caller declares a tolerance. The
 * declaration carries the version such a file is read as and the reason it is
 * tolerated, and the reason travels back in the summary, so a tolerance is a
 * fact a caller can print rather than a decision nobody can find. A tolerance
 * declared with no reason is refused: that is the silent path this module
 * exists to remove, spelled one level up.
 *
 * Migration is a table of steps, keyed by the version each step starts from and
 * applied in order up to the highest supported version. A step this reader
 * claims to support but does not carry is a refusal, not a quiet pass-through:
 * a half-migrated document is worse than an unread one.
 *
 * Nothing here knows what a store means. A document is opaque, a row is a bag
 * of declared field names, and the migration steps belong to the store's own
 * module.
 */
import { existsSync, readFileSync } from "node:fs";

/**
 * Why a read was refused. `version` is a disagreement about versions (an
 * unsupported one, a versionless file nobody tolerates, a migration step this
 * reader claims but does not carry); `content` is a file that is not the shape
 * its reader expects. The distinction exists so a caller can report the two
 * without parsing the message.
 */
export type StoreRefusalKind = "version" | "content";

/** A refused read: the file it names, the version found (null when none) and the versions read. */
export class StoreRefusal extends Error {
  readonly path: string;
  readonly found: number | null;
  readonly supported: readonly number[];
  readonly kind: StoreRefusalKind;

  constructor(
    message: string,
    path: string,
    found: number | null,
    supported: readonly number[],
    kind: StoreRefusalKind,
  ) {
    super(message);
    this.name = "StoreRefusal";
    this.path = path;
    this.found = found;
    this.supported = supported;
    this.kind = kind;
  }
}

/** One migration step: the document or row as the previous version held it. */
export type StoreMigration = Readonly<Record<number, (data: unknown) => unknown>>;

/**
 * The declaration that lets a versionless file through. `accept` is the literal
 * `true` so that a tolerance that does not accept cannot be written; a file
 * nobody tolerates simply has no declaration.
 */
export interface LegacyDeclaration {
  readonly accept: true;
  readonly reason: string;
  /** The version a versionless file is read as. Defaults to 0. */
  readonly version?: number;
}

export interface JsonReadOptions {
  readonly supported: readonly number[];
  readonly migrate?: StoreMigration;
  readonly legacy?: LegacyDeclaration;
}

export interface JsonlReadOptions {
  readonly supported: readonly number[];
  /** The version rows are read as when a row does not declare one. */
  readonly rowVersion: number;
  /** Fields every row must carry; a row missing one is counted `incomplete`. */
  readonly required?: readonly string[];
  /** Fields a row may omit; a row missing one is counted `partial`. */
  readonly optional?: readonly string[];
  readonly migrate?: StoreMigration;
}

/** What a JSON read found, including the tolerance it used and the steps it ran. */
export interface JsonSummary {
  readonly path: string;
  readonly present: boolean;
  /** The version the data reads at after migration; null when the file is absent. */
  readonly version: number | null;
  /** The version the file declared; null when it declared none, or is absent. */
  readonly found: number | null;
  /** The declared tolerance that let a versionless file through, reason included. */
  readonly legacy: { readonly version: number; readonly reason: string } | null;
  /** Steps applied, as `from->to`, in the order they ran. */
  readonly migrated: readonly string[];
}

/** Why one line could not be used, with the line that carried it. */
export interface JsonlProblem {
  readonly line: number;
  readonly kind: "unparseable" | "incomplete" | "unknown-version";
  readonly detail: string;
}

/** What a JSONL read counted. `rows` plus the four classes equals `lines`. */
export interface JsonlSummary {
  readonly path: string;
  readonly present: boolean;
  /** The version rows read at after migration. */
  readonly rowVersion: number;
  /** Non-blank lines in the file. */
  readonly lines: number;
  readonly rows: number;
  readonly partial: number;
  readonly unparseable: number;
  readonly incomplete: number;
  readonly unknownVersion: number;
  readonly migratedRows: number;
  /** The first `PROBLEM_LIMIT` unusable lines; the counts above stay complete. */
  readonly problems: readonly JsonlProblem[];
  /** Unusable lines whose detail was not kept because the list was full. */
  readonly problemsOmitted: number;
}

export interface JsonRead<T> {
  readonly data: T | null;
  readonly summary: JsonSummary;
}

export interface JsonlRead {
  readonly rows: ReadonlyArray<Record<string, unknown>>;
  readonly summary: JsonlSummary;
}

/**
 * How many unusable lines carry a detail string. A store read at session start
 * must not turn a file with thousands of torn lines into thousands of objects
 * held for the session; the counts stay complete, so nothing is lost from the
 * accounting, only from the per-line list a reader prints.
 */
const PROBLEM_LIMIT = 100;

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The supported set as a sorted, ascending list. A wiring error rather than a
 * refusal: no file is named because the caller is the thing that is wrong.
 */
function supportedVersions(caller: string, supported: readonly number[]): number[] {
  if (!Array.isArray(supported) || supported.length === 0) {
    throw new Error(`${caller}: supported must list at least one version`);
  }
  for (const version of supported) {
    if (!Number.isInteger(version) || version < 0) {
      throw new Error(
        `${caller}: supported holds ${JSON.stringify(version)}, which is not a version`,
      );
    }
  }
  return [...supported].sort((left, right) => left - right);
}

/** One step, or the refusal that names the gap between two versions this reader claimed. */
function stepOf(
  path: string,
  migrate: StoreMigration | undefined,
  from: number,
  found: number | null,
  supported: readonly number[],
): (data: unknown) => unknown {
  const step = migrate?.[from];
  if (step === undefined) {
    throw new StoreRefusal(
      `${path}: no migration step from version ${from} to ${from + 1}; this reader supports ` +
        `${supported.join(", ")}`,
      path,
      found,
      supported,
      "version",
    );
  }
  return step;
}

/**
 * Read one JSON document under the version rule.
 *
 * A missing file is not a refusal: it declares no version because it has no
 * content, and its summary says `present: false` so a caller can tell an absent
 * store from a broken one.
 */
export function readVersionedJson<T = unknown>(
  path: string,
  options: JsonReadOptions,
): JsonRead<T> {
  const supported = supportedVersions("readVersionedJson", options.supported);
  const highest = supported[supported.length - 1];

  if (!existsSync(path)) {
    return {
      data: null,
      summary: { path, present: false, version: null, found: null, legacy: null, migrated: [] },
    };
  }

  let source: string;
  try {
    source = readFileSync(path, "utf-8");
  } catch (error) {
    throw new StoreRefusal(
      `${path}: cannot be read: ${reasonOf(error)}`,
      path,
      null,
      supported,
      "content",
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch (error) {
    throw new StoreRefusal(
      `${path}: is not JSON: ${reasonOf(error)}`,
      path,
      null,
      supported,
      "content",
    );
  }
  if (!isRecord(parsed)) {
    throw new StoreRefusal(`${path}: top level is not an object`, path, null, supported, "content");
  }

  const declared = parsed.version;
  let found: number | null = null;
  let legacy: { version: number; reason: string } | null = null;
  let from: number;

  if (declared === undefined || declared === null) {
    const declaration = options.legacy;
    if (declaration === undefined) {
      throw new StoreRefusal(
        `${path}: declares no version; this reader supports ${supported.join(", ")}`,
        path,
        null,
        supported,
        "version",
      );
    }
    const reason = typeof declaration.reason === "string" ? declaration.reason.trim() : "";
    if (reason === "") {
      throw new StoreRefusal(
        `${path}: a legacy declaration must carry a reason; a tolerance nobody can read is the ` +
          "silent path this reader refuses",
        path,
        null,
        supported,
        "version",
      );
    }
    const legacyVersion = declaration.version ?? 0;
    if (!Number.isInteger(legacyVersion) || legacyVersion < 0) {
      throw new StoreRefusal(
        `${path}: legacy version ${JSON.stringify(declaration.version)} is not a version`,
        path,
        null,
        supported,
        "version",
      );
    }
    legacy = { version: legacyVersion, reason };
    from = legacyVersion;
  } else {
    if (!Number.isInteger(declared) || (declared as number) < 0) {
      throw new StoreRefusal(
        `${path}: version ${JSON.stringify(declared)} is not a version; this reader supports ` +
          `${supported.join(", ")}`,
        path,
        null,
        supported,
        "version",
      );
    }
    found = declared as number;
    from = found;
  }

  if (!supported.includes(from)) {
    throw new StoreRefusal(
      `${path}: declares version ${from}${legacy === null ? "" : ` (read as legacy version ${from})`}` +
        `; this reader supports ${supported.join(", ")}`,
      path,
      found,
      supported,
      "version",
    );
  }

  const migrated: string[] = [];
  let data: unknown = parsed;
  for (let version = from; version < highest; version++) {
    data = stepOf(path, options.migrate, version, found ?? from, supported)(data);
    migrated.push(`${version}->${version + 1}`);
  }

  return {
    data: data as T,
    summary: { path, present: true, version: highest, found, legacy, migrated },
  };
}

/**
 * Read one JSONL file under the version rule, counting every line that could
 * not be used instead of throwing the file away for it.
 */
export function readVersionedJsonl(path: string, options: JsonlReadOptions): JsonlRead {
  const supported = supportedVersions("readVersionedJsonl", options.supported);
  const highest = supported[supported.length - 1];
  const declaredRow = options.rowVersion;

  if (!Number.isInteger(declaredRow) || declaredRow < 0) {
    throw new Error(
      `readVersionedJsonl: rowVersion is ${JSON.stringify(declaredRow)}, which is not a version`,
    );
  }
  if (!supported.includes(declaredRow)) {
    throw new StoreRefusal(
      `${path}: rows are declared at version ${declaredRow}; this reader supports ` +
        `${supported.join(", ")}`,
      path,
      declaredRow,
      supported,
      "version",
    );
  }

  const required = options.required ?? [];
  const optional = options.optional ?? [];
  const empty: JsonlSummary = {
    path,
    present: false,
    rowVersion: highest,
    lines: 0,
    rows: 0,
    partial: 0,
    unparseable: 0,
    incomplete: 0,
    unknownVersion: 0,
    migratedRows: 0,
    problems: [],
    problemsOmitted: 0,
  };
  if (!existsSync(path)) return { rows: [], summary: empty };

  let source: string;
  try {
    source = readFileSync(path, "utf-8");
  } catch (error) {
    throw new StoreRefusal(
      `${path}: cannot be read: ${reasonOf(error)}`,
      path,
      null,
      supported,
      "content",
    );
  }

  const rows: Record<string, unknown>[] = [];
  const problems: JsonlProblem[] = [];
  let lines = 0;
  let partial = 0;
  let unparseable = 0;
  let incomplete = 0;
  let unknownVersion = 0;
  let migratedRows = 0;

  const unusable = (line: number, kind: JsonlProblem["kind"], detail: string): void => {
    if (problems.length < PROBLEM_LIMIT) problems.push({ line, kind, detail });
  };

  const text = source.split("\n");
  for (let index = 0; index < text.length; index++) {
    const raw = text[index];
    if (raw.trim() === "") continue;
    lines++;
    const line = index + 1;

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      unparseable++;
      unusable(line, "unparseable", `not JSON: ${reasonOf(error)}`);
      continue;
    }
    if (!isRecord(parsed)) {
      unparseable++;
      unusable(line, "unparseable", "line is not an object");
      continue;
    }

    const declared = parsed.version;
    let rowVersion: number;
    if (declared === undefined || declared === null) {
      rowVersion = declaredRow;
    } else if (!Number.isInteger(declared) || (declared as number) < 0) {
      unknownVersion++;
      unusable(line, "unknown-version", `version ${JSON.stringify(declared)} is not a version`);
      continue;
    } else if (!supported.includes(declared as number)) {
      unknownVersion++;
      unusable(
        line,
        "unknown-version",
        `declares version ${declared}; this reader supports ${supported.join(", ")}`,
      );
      continue;
    } else {
      rowVersion = declared as number;
    }

    let row: Record<string, unknown> = parsed;
    for (let version = rowVersion; version < highest; version++) {
      row = stepOf(path, options.migrate, version, rowVersion, supported)(row) as Record<
        string,
        unknown
      >;
      migratedRows++;
    }

    const missing = required.filter((field) => !Object.hasOwn(row, field));
    if (missing.length > 0) {
      incomplete++;
      unusable(line, "incomplete", `missing ${missing.join(", ")}`);
      continue;
    }
    if (optional.some((field) => !Object.hasOwn(row, field))) partial++;
    rows.push(row);
  }

  return {
    rows,
    summary: {
      path,
      present: true,
      rowVersion: highest,
      lines,
      rows: rows.length,
      partial,
      unparseable,
      incomplete,
      unknownVersion,
      migratedRows,
      problems,
      problemsOmitted: Math.max(0, unparseable + incomplete + unknownVersion - problems.length),
    },
  };
}

/** One JSON read as a line: the version, the tolerance used, the steps it ran. */
export function describeJsonSummary(summary: JsonSummary): string {
  if (!summary.present) return "absent";
  const parts: string[] = [];
  if (summary.legacy !== null) {
    parts.push(`legacy ${summary.legacy.version} accepted`);
  }
  if (summary.migrated.length > 0) {
    parts.push(`migrated ${summary.migrated.join(", ")}`);
  }
  const version = `version ${summary.version}`;
  return parts.length === 0 ? version : `${version} (${parts.join(", ")})`;
}

/** One JSONL read as a line: rows first, then every class that is not zero. */
export function describeJsonlSummary(summary: JsonlSummary): string {
  if (!summary.present) return "absent";
  const rows = `${summary.rows} row${summary.rows === 1 ? "" : "s"}`;
  const classes: string[] = [];
  if (summary.partial > 0) classes.push(`${summary.partial} partial`);
  if (summary.incomplete > 0) classes.push(`${summary.incomplete} incomplete`);
  if (summary.unparseable > 0) classes.push(`${summary.unparseable} unparseable`);
  if (summary.unknownVersion > 0) classes.push(`${summary.unknownVersion} unknown-version`);
  return classes.length === 0 ? rows : `${rows}, ${classes.join(", ")}`;
}
