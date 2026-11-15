/**
 * OUTBOUND IDENTITY — the one line every message this process sends carries.
 *
 * The owner cannot tell two agents apart in one chat: both write through the
 * same bot, and a reply to either reaches whichever process holds the poller.
 * A message therefore states its sender, rendered from what the process can
 * actually observe:
 *
 *   [braid · worker · pi-braid · session 01a1da43 · pid 98675]
 *    │       │        │          │                  │
 *    │       │        │          │                  └─ the OS process (two
 *    │       │        │          │                     processes never share one)
 *    │       │        │          └─ the pi session, short (two sessions never
 *    │       │        │             share one)
 *    │       │        └─ the working directory's name
 *    │       └─ BRAID_SESSION_ROLE: seat | worker
 *    └─ the product that rendered the label
 *
 * Rules the line obeys:
 *
 *  - Role, project and pid come from the process itself (env, cwd, pid). The
 *    session does not: pi DELETES `PI_SESSION_ID` (and `PI_SESSION_FILE`) from
 *    the environment it hands an extension and re-injects them only into bash
 *    children (pi-core tools/bash.ts, `resolveSpawnContext`), so a label read
 *    from `process.env` said `session unknown` on every message while the
 *    digest beside it named the real id from the extension context. The id now
 *    comes from that context through a getter the package registers once
 *    (`setIdentitySessionSource`); the environment stays the fallback a
 *    standalone script still has. Nothing is passed per message: a caller
 *    cannot label a message as someone else's, and cannot forget to label it
 *    at all (`planOutbound` attaches it).
 *  - An unobservable field says so. `unknown role`, `unknown project`,
 *    `session unknown` are answers; an invented value is not. A marker this
 *    build does not know (`BRAID_SESSION_ROLE=oracle`) renders as
 *    `unknown role (oracle)` — the raw marker is reported, not upgraded to a
 *    role the code does not have.
 *  - It is stable: one render per session, memoized. The memo is keyed on the
 *    session the getter answers with, so a stable session reads the same line
 *    every time (what makes it usable as a label), a label rendered before the
 *    first `session_start` corrects itself once the context arrives, and a
 *    reload inside one process relabels to the session that now sends. Two
 *    processes differ on at least one field (session, pid, or cwd).
 *  - It is one line: field values are clipped of separators, brackets and
 *    newlines, so a hostile project name cannot break the label or the parse.
 *
 * This module imports nothing from the package (only node builtins) so the
 * file runs as its own script under node's type stripping — a worker session,
 * which registers no telegram surface at all, can still print the label it
 * would attach (see `identityCli`).
 */

import { realpathSync } from "node:fs";
import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ParseMode } from "./telegram-client.js";

/**
 * Role marker variable. Owned by `session-role.ts` (which decides the RUNTIME
 * role, defaulting an unset marker to seat); this module only READS the marker
 * for display, so it must not import that module — see the standalone-script
 * note above. `identity.test.mjs` pins the two constants equal.
 */
export const IDENTITY_ROLE_ENV = "BRAID_SESSION_ROLE";
/** pi's session id (a uuid) — the short discriminator's source. */
export const IDENTITY_SESSION_ID_ENV = "PI_SESSION_ID";
/** Fallback discriminator when the id is absent: the session file's own name. */
export const IDENTITY_SESSION_FILE_ENV = "PI_SESSION_FILE";

/** Field values longer than this are clipped, not truncated mid-word silently. */
const MAX_FIELD_CHARS = 40;
/** Short session discriminator length (a uuid's first group). */
const SESSION_KEY_CHARS = 8;

const LINE_OPEN = "[braid · ";
const LINE_CLOSE = "]";
/**
 * A line this module would render. The `\\?` pairs tolerate the Markdown-escaped
 * form (`\[…\]`), so a body that already carries the label is recognized in
 * every parse mode and never doubled.
 */
const IDENTITY_LINE_RE = /^\\?\[braid · [^[\]\n]*\\?\]$/;

export interface IdentityInput {
  /** Environment to read (defaults to `process.env`). */
  env?: Record<string, string | undefined>;
  /** Working directory (defaults to `process.cwd()`). */
  cwd?: string;
  /** Process id (defaults to `process.pid`, or `process.pid` of the caller's node). */
  pid?: number;
  /**
   * The live session id (the ExtensionContext's), when the caller has one.
   * Preferred over the environment, which an extension never sees.
   */
  sessionId?: string;
}

/**
 * Clip a value to something a one-line label can hold: no separators, no
 * brackets, no newlines, at most MAX_FIELD_CHARS (with an ellipsis when cut).
 */
function clipField(value: string): string {
  const cleaned = value
    .replace(/[[\]·\r\n\t]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (cleaned.length <= MAX_FIELD_CHARS) return cleaned;
  return `${cleaned.slice(0, MAX_FIELD_CHARS - 1).trimEnd()}…`;
}

/**
 * The role field. `seat` and `worker` are the values the orchestrator exports;
 * anything else is reported as unknown WITHOUT dropping what the environment
 * actually said, because "oracle" is information and "seat" would be a lie.
 */
function roleField(env: Record<string, string | undefined>): string {
  const raw = env[IDENTITY_ROLE_ENV]?.trim();
  if (!raw) return "unknown role";
  const normalized = raw.toLowerCase();
  if (normalized === "seat" || normalized === "worker") return normalized;
  return `unknown role (${clipField(raw)})`;
}

/** The project is the working directory's name, and nothing else. */
function projectField(cwd: string): string {
  const name = cwd ? basename(cwd) : "";
  if (!name || name === "/" || name === ".") return "unknown project";
  return clipField(name);
}

/**
 * The session discriminator: the live context's id when the caller has one,
 * else the first group of pi's session uuid from the environment, else the
 * session file's name (pi names the file after the session), else unknown.
 */
function sessionField(
  env: Record<string, string | undefined>,
  liveSessionId?: string,
): string {
  const live = liveSessionId?.trim();
  if (live) return shortSession(live);
  const id = env[IDENTITY_SESSION_ID_ENV]?.trim();
  if (id) return shortSession(id);
  const file = env[IDENTITY_SESSION_FILE_ENV]?.trim();
  if (file) {
    const name = basename(file).replace(/\.jsonl$/i, "");
    const tail = name.includes("_")
      ? name.slice(name.lastIndexOf("_") + 1)
      : name;
    if (tail) return shortSession(tail);
  }
  return "unknown";
}

function shortSession(raw: string): string {
  const cleaned = raw.replace(/[^A-Za-z0-9_-]/g, "");
  const head = cleaned.split("-")[0] || cleaned;
  return head.slice(0, SESSION_KEY_CHARS) || "unknown";
}

/** Render the label for one observed process. Pure: no clock, no IO. */
export function renderIdentityLine(input: IdentityInput = {}): string {
  const env = input.env ?? process.env;
  const cwd = input.cwd ?? process.cwd();
  const rawPid = input.pid ?? process.pid;
  const pid =
    Number.isInteger(rawPid) && rawPid > 0 ? String(rawPid) : "unknown";
  return (
    LINE_OPEN +
    roleField(env) +
    " · " +
    projectField(cwd) +
    " · session " +
    sessionField(env, input.sessionId) +
    " · pid " +
    pid +
    LINE_CLOSE
  );
}

/**
 * Where the live session id comes from: the package registers a getter for the
 * ExtensionContext it already holds. Module-level because the label is
 * rendered inside `planOutbound`, which has no context of its own, and every
 * send path in the package plans through it.
 */
let sessionSource: (() => string | undefined) | undefined;

/**
 * Register (or clear, with `undefined`) the live session-id getter. A process
 * that registers none keeps the environment fallback.
 */
export function setIdentitySessionSource(
  source: (() => string | undefined) | undefined,
): void {
  sessionSource = source;
}

/**
 * The registered getter's answer, or undefined. A context left behind by a
 * replaced session throws on access and answers undefined, which is the same
 * honest "I cannot name it" the rest of this file falls back to.
 */
function observedSessionId(): string | undefined {
  if (!sessionSource) return undefined;
  try {
    const id = sessionSource();
    return typeof id === "string" && id.trim() ? id.trim() : undefined;
  } catch {
    return undefined;
  }
}

let cachedLine: { sessionKey: string; line: string } | undefined;

/**
 * The label THIS process attaches, rendered once per session and remembered.
 * Memoizing is the stability promise; keying the memo on the session id is
 * what lets a label rendered before the context existed (or after a reload)
 * name the session that now sends instead of freezing "unknown" for the life
 * of the process.
 */
export function currentIdentityLine(): string {
  const sessionId = observedSessionId();
  const sessionKey = sessionId ?? "";
  if (cachedLine !== undefined && cachedLine.sessionKey === sessionKey)
    return cachedLine.line;
  const line = renderIdentityLine(sessionId ? { sessionId } : {});
  cachedLine = { sessionKey, line };
  return line;
}

/** Drop the memoized label (fixtures that model two sessions in one). */
export function resetIdentityCache(): void {
  cachedLine = undefined;
}

/** Is this line one this module renders (in any parse mode's escaping)? */
export function isIdentityLine(line: string): boolean {
  return IDENTITY_LINE_RE.test(line.trim());
}

/**
 * Split a body into its leading label (when it has one) and the rest. The
 * label is metadata this host attaches, so it is exactly one leading line.
 */
export function splitIdentity(text: string): { line?: string; body: string } {
  const newline = text.indexOf("\n");
  const first = newline === -1 ? text : text.slice(0, newline);
  if (!isIdentityLine(first)) return { body: text };
  return {
    line: first.trim(),
    body: newline === -1 ? "" : text.slice(newline + 1),
  };
}

/**
 * Escape the label for the wire it ships on. Only the label is escaped — the
 * sender's body is the sender's business — and the RENDERED text is unchanged
 * in every mode.
 */
function encodeIdentityLine(
  line: string,
  parseMode: ParseMode | undefined,
): string {
  if (parseMode === "HTML") {
    return line
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }
  if (parseMode === "Markdown") {
    // Legacy Markdown's escaping set that can change how the label renders.
    return line.replace(/([_*[\]`\\])/g, "\\$1");
  }
  return line;
}

/**
 * The wire body: the label on its own first line, the authored body after it.
 *
 * Idempotent — a body that already carries a label (the tracked message reads
 * the stored one back) is relabelled, never doubled. `line` exists for exactly
 * one caller: the chat-keyed tracked message, whose record outlives the
 * process that pinned it, so its label must stay the pinner's rather than flip
 * to whoever edits it next.
 */
export function attachIdentity(
  text: string,
  parseMode?: ParseMode,
  line?: string,
): string {
  if (!text.trim()) return text;
  const { line: existing, body } = splitIdentity(text);
  if (!body.trim()) {
    // A body that is nothing BUT a label: there is nothing to label.
    return existing ? encodeIdentityLine(line ?? existing, parseMode) : text;
  }
  const label = line ?? currentIdentityLine();
  return `${encodeIdentityLine(label, parseMode)}\n${body}`;
}

/**
 * Print the label for the environment this script runs in.
 *
 *   node <package>/src/lib/identity.ts              → this node process
 *   node <package>/src/lib/identity.ts --pid 98675  → the process with that pid
 *
 * `--pid` exists because role, project and session are inherited by a child
 * (so a child answers for its parent), while the pid is not: an agent's own
 * shell is `$$`, its pi process is `$PPID`. Pass `--pid "$PPID"` there.
 */
function identityCli(argv: string[]): number {
  let pid = process.pid;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      process.stdout.write(
        "usage: identity.ts [--pid <pid>]  - print the outbound identity line\n",
      );
      return 0;
    }
    if (arg === "--pid") {
      const raw = argv[++i];
      const parsed = Number(raw);
      if (!Number.isInteger(parsed) || parsed <= 0 || raw === undefined) {
        process.stderr.write("identity.ts: --pid needs a positive integer\n");
        return 2;
      }
      pid = parsed;
      continue;
    }
    process.stderr.write(`identity.ts: unknown argument ${arg} (try --help)\n`);
    return 2;
  }
  process.stdout.write(`${renderIdentityLine({ pid })}\n`);
  return 0;
}

/**
 * Is this file the program node was asked to run? A string comparison is not
 * enough: on macOS `/tmp` is a symlink to `/private/tmp`, and a script invoked
 * through a symlink keeps the link in `process.argv[1]` while `import.meta.url`
 * names the real file. Same file, different strings — so compare the REAL
 * paths. That costs one stat pair per process (this runs once, at import), and
 * only on the path where the plain comparison already failed.
 */
function isEntryPoint(): boolean {
  const entry = process.argv[1];
  if (typeof entry !== "string" || entry.length === 0) return false;
  const self = fileURLToPath(import.meta.url);
  if (resolve(entry) === self) return true;
  try {
    return realpathSync(entry) === realpathSync(self);
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  process.exitCode = identityCli(process.argv.slice(2));
}
