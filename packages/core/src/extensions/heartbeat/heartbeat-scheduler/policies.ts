/**
 * Default Policies for heartbeat scheduler.
 *
 * Policies are evaluated on each tick and can trigger whispers or signals.
 * Includes: verification hint, reflection reminder, web verification hint,
 * and proactive context monitoring with auto-finalize at 90%.
 */

import type { Policy, PolicyContext, BeliefStore } from "../../../lib/store/belief-store.js";
import type { ToolTracking } from "./types.js";
import { createLogger } from "../../../lib/core/logger.js";
import {
  USAGE_WHISPER_SOFT,
  USAGE_WHISPER_ADVISORY,
  USAGE_WHISPER_WARNING,
  USAGE_WHISPER_CRITICAL,
  USAGE_FIRED_RESET_BELOW,
} from "../../../lib/detection/context-thresholds.js";
import {
  CONTEXT_USAGE_TIERS,
  getContextUsage,
  type ContextUsageTierInfo,
} from "../../../lib/detection/context-tiers.js";

const log = createLogger("heartbeat:policies");

/**
 * Persist fired threshold set across invocations so the context-monitor
 * policy doesn't re-fire the same threshold every tick.
 * Cleared when usage drops below USAGE_FIRED_RESET_BELOW.
 */
const _firedThresholds: Set<number> = new Set();

export const VERIFICATION_TOOLS = new Set([
  "grep",
  "find",
  "read",
  "document_parse",
  "browser_content",
  "fetch_content",
]);

export const WEB_TOOLS = new Set(["fetch_content", "browser_navigate", "browser_content"]);

export const CODE_TOOLS = new Set(["bash", "write", "edit"]);

// ═══════════════════════════════════════════════════════════════════════════
// VERIFICATION-SHAPE RECOGNITION FOR BASH
// ═══════════════════════════════════════════════════════════════════════════
// VERIFICATION_TOOLS is a tool-NAME set, and the same work routinely runs
// through bash: `grep -rn "needle" src`, `git diff main...HEAD`, `node -e
// 'console.log(m.x)'`. The set cannot see it, so the verification counter
// stayed at zero while the agent verified and the hint below told the agent it
// had not verified in ten turns. Counting every bash call would swing the
// defect the other way — an edit, a build or a publish script is not
// verification, and a counter that accepts them silences the hint it exists to
// raise.
//
// The rule, in one sentence: a command counts when it puts an inspecting
// program at a program position and no mutating program anywhere.
//   - program positions are the first word of each `;` `&&` `||` `|` `&`
//     segment, tokenized quote-aware (`grep -n "a|b" f` is one segment);
//   - inspecting: search/locate, read, compare/extract programs, git read
//     subcommands, and an inline interpreter probe (`node -e`, `python -c`)
//     whose script shows no write primitive;
//   - mutating: rm/mv/cp/mkdir/tee/dd/chmod…, `sed -i`, `perl -i`, git write
//     subcommands, and any unquoted redirect to a file other than /dev/null.
// Both directions matter: the two named holes are an interpreter script that
// writes through a primitive outside INLINE_WRITE_RE, and a mutating program
// behind `eval` or a heredoc body (both are read as inspection when the same
// command also inspects — they are listed here rather than guessed at).

/** Programs that inspect existing state: search, locate, read, compare, extract. */
const INSPECT_PROGRAMS = new Set([
  "grep",
  "egrep",
  "fgrep",
  "rg",
  "ag",
  "ack",
  "ack-grep",
  "ugrep",
  "pcregrep",
  "find",
  "fd",
  "fdfind",
  "locate",
  "cat",
  "tac",
  "head",
  "tail",
  "bat",
  "less",
  "more",
  "wc",
  "nl",
  "od",
  "xxd",
  "strings",
  "file",
  "stat",
  "ls",
  "tree",
  "realpath",
  "readlink",
  "jq",
  "yq",
  "diff",
  "diff3",
  "cmp",
  "comm",
  "cut",
  "uniq",
  "tr",
  "column",
  "awk",
  "gawk",
  "sed",
]);

/** Programs that mutate the tree. Any one of them vetoes the call. */
const MUTATE_PROGRAMS = new Set([
  "rm",
  "rmdir",
  "mv",
  "cp",
  "ln",
  "touch",
  "mkdir",
  "install",
  "truncate",
  "dd",
  "shred",
  "tee",
  "patch",
  "chmod",
  "chown",
  "chgrp",
]);

/**
 * `git` subcommands that only read (the inspection side of the verbs the
 * destructive gate covers separately).
 */
const GIT_READ_SUBS = new Set([
  "diff",
  "diff-tree",
  "diff-index",
  "diff-files",
  "show",
  "log",
  "status",
  "grep",
  "blame",
  "shortlog",
  "whatchanged",
  "ls-files",
  "ls-tree",
  "cat-file",
  "rev-parse",
  "rev-list",
  "show-ref",
  "for-each-ref",
  "describe",
  "merge-base",
  "name-rev",
  "count-objects",
  "fsck",
]);

/** `git` subcommands that write. Conservative: a remote/config/branch/tag
 * verb may mutate, so it vetoes rather than counts. */
const GIT_WRITE_SUBS = new Set([
  "add",
  "commit",
  "push",
  "pull",
  "fetch",
  "checkout",
  "switch",
  "restore",
  "reset",
  "revert",
  "merge",
  "rebase",
  "cherry-pick",
  "stash",
  "apply",
  "am",
  "clean",
  "rm",
  "mv",
  "tag",
  "branch",
  "init",
  "clone",
  "config",
  "remote",
  "submodule",
  "worktree",
  "update-index",
  "update-ref",
  "symbolic-ref",
  "notes",
  "gc",
  "prune",
  "reflog",
]);

/** Interpreters whose inline-eval form can be a probe. */
const INLINE_INTERPRETERS = new Set(["node", "deno", "bun", "python", "python3", "ruby"]);

/** Write primitives inside an inline script (both JS/TS and Python spellings). */
const INLINE_WRITE_RE =
  /writeFileSync|writeFile\(|appendFileSync|createWriteStream|rmSync|unlinkSync|renameSync|mkdirSync|copyFileSync|truncateSync|chmodSync|openSync\([^)]*["'`][wa]|os\.remove|os\.rename|shutil\.|open\([^)]*["'`][wa]/;

/** Wrappers whose presence does not decide the kind of the segment. */
const WRAPPER_PROGRAMS = new Set(["sudo", "env", "time", "nice", "command", "nohup"]);

/** Tokens that end one command segment. */
const SEGMENT_SEPARATORS = new Set([";", "&&", "||", "|", "&", "\n"]);

/** The program name without its path (`/usr/bin/grep` → `grep`). */
function baseName(token: string): string {
  const parts = token.split("/");
  return parts[parts.length - 1] ?? token;
}

/**
 * Quote-aware tokenizer that keeps shell operators as their own tokens
 * (`;` `&&` `||` `|` `&` newline `>` `>>`, and `&1`/`&2` as one token) and
 * strips quote characters. An escaped character stays literal, so `find …
 * -exec grep … \;` yields the word `;` rather than a separator.
 */
function tokenizeCommand(command: string): string[] {
  const tokens: string[] = [];
  let cur = "";
  let quote: '"' | "'" | null = null;
  const flush = (): void => {
    if (cur) {
      tokens.push(cur);
      cur = "";
    }
  };
  for (let i = 0; i < command.length; i++) {
    const ch = command[i] ?? "";
    if (quote) {
      if (ch === "\\" && quote === '"') {
        cur += command[i + 1] ?? "";
        i++;
        continue;
      }
      if (ch === quote) {
        quote = null;
        continue;
      }
      cur += ch;
      continue;
    }
    if (ch === "\\") {
      cur += command[i + 1] ?? "";
      i++;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      flush();
      if (ch === "\n") tokens.push("\n");
      continue;
    }
    if (ch === ";" || ch === "&") {
      flush();
      const next = command[i + 1] ?? "";
      if (ch === "&" && /\d/.test(next)) {
        tokens.push(`&${next}`);
        i++;
        continue;
      }
      if (ch === "&" && next === "&") {
        tokens.push("&&");
        i++;
        continue;
      }
      tokens.push(ch);
      continue;
    }
    if (ch === "|") {
      flush();
      if ((command[i + 1] ?? "") === "|") {
        tokens.push("||");
        i++;
        continue;
      }
      tokens.push("|");
      continue;
    }
    if (ch === ">") {
      flush();
      if ((command[i + 1] ?? "") === ">") {
        tokens.push(">>");
        i++;
        continue;
      }
      tokens.push(">");
      continue;
    }
    cur += ch;
  }
  flush();
  return tokens;
}

/** Split tokenized commands into segments at the separators. */
function splitSegments(tokens: string[]): string[][] {
  const out: string[][] = [];
  let cur: string[] = [];
  for (const token of tokens) {
    if (SEGMENT_SEPARATORS.has(token)) {
      if (cur.length > 0) out.push(cur);
      cur = [];
      continue;
    }
    cur.push(token);
  }
  if (cur.length > 0) out.push(cur);
  return out;
}

/**
 * A redirect that writes a real file. `/dev/null` and fd duplications
 * (`2>&1`) are the ordinary shapes of a silent inspection and stay benign — a
 * redirect into a path is a write, whatever program it follows.
 */
function writesFile(tokens: string[]): boolean {
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token !== ">" && token !== ">>") continue;
    const target = tokens[i + 1];
    if (!target || SEGMENT_SEPARATORS.has(target)) continue;
    if (/^\/dev\/(?:null|stdout|stderr)$/.test(target)) continue;
    if (/^&\d$/.test(target)) continue;
    return true;
  }
  return false;
}

/** The first argument that is not a flag (`xargs -I{} rm` → `rm`). */
function firstArgument(args: string[]): string | null {
  for (const arg of args) if (!arg.startsWith("-")) return arg;
  return null;
}

/** Classify one segment by the program in its program position. */
function classifySegment(tokens: string[]): "inspect" | "mutate" | "neutral" {
  let i = 0;
  while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i] ?? "")) i++;
  while (i < tokens.length && WRAPPER_PROGRAMS.has(baseName(tokens[i] ?? ""))) i++;
  const program = tokens[i] ? baseName(tokens[i] as string) : "";
  if (!program) return "neutral";
  const args = tokens.slice(i + 1);

  if (MUTATE_PROGRAMS.has(program)) return "mutate";
  // xargs runs its first non-flag argument: classify the thing it runs.
  if (program === "xargs") {
    const target = firstArgument(args);
    return target ? classifySegment([target]) : "neutral";
  }
  if (program === "git") {
    const sub = args.find((a) => GIT_READ_SUBS.has(a) || GIT_WRITE_SUBS.has(a));
    if (!sub) return "neutral";
    return GIT_WRITE_SUBS.has(sub) ? "mutate" : "inspect";
  }
  const inPlace = args.some(
    (a) => a === "--in-place" || /^-[A-Za-z]*i/.test(a) || /^--in-place=/.test(a),
  );
  if (program === "sed" || program === "perl") {
    if (inPlace) return "mutate";
    return "inspect";
  }
  if (INLINE_INTERPRETERS.has(program)) {
    const inline = args.some((a) => a === "-e" || a === "-p" || a === "--eval" || a === "-c");
    if (!inline) return "neutral";
    return INLINE_WRITE_RE.test(args.join(" ")) ? "mutate" : "inspect";
  }
  if (INSPECT_PROGRAMS.has(program)) return "inspect";
  return "neutral";
}

/** True when the command is inspection-shaped (see the rule above). */
export function bashCommandIsVerification(command: string): boolean {
  if (!command.trim()) return false;
  const tokens = tokenizeCommand(command);
  if (writesFile(tokens)) return false;
  let inspected = false;
  for (const segment of splitSegments(tokens)) {
    const kind = classifySegment(segment);
    if (kind === "mutate") return false;
    if (kind === "inspect") inspected = true;
  }
  return inspected;
}

/**
 * Does this tool call count as verification activity? The name set first, then
 * bash by the command's shape. Every other tool is not verification.
 */
export function isVerificationToolCall(toolName: string, input: unknown): boolean {
  if (VERIFICATION_TOOLS.has(toolName)) return true;
  if (toolName !== "bash") return false;
  const command = (input as { command?: unknown } | undefined)?.command;
  return typeof command === "string" && bashCommandIsVerification(command);
}

export function createDefaultPolicies(
  getToolTracking: () => ToolTracking,
  onSignal: (type: string, data: Record<string, unknown>) => void,
  sendWhisper: (msg: string) => void,
  sendSteerMessage: (msg: string) => void,
): Policy[] {
  return [
    {
      id: "verify-hint",
      name: "Verification Hint",
      description: "Whisper if no verification activity in 10+ turns",
      priority: 50,
      cooldownMs: 30_000,
      enabled: true,
      lastActivated: 0,
      trigger: async (_store: BeliefStore, ctx: PolicyContext) => {
        const t = getToolTracking();
        const turnsSince = ctx.turnNumber - t.lastVerificationTurn;
        return turnsSince >= 10 && t.totalToolsUsed > 3;
      },
      action: async (ctx: PolicyContext) => {
        sendWhisper(
          "No verification (grep/read/search) in 10+ turns. " +
            "Consider: Are you sure the implementation is correct? " +
            "Verify with grep or read to confirm.",
        );
        onSignal("verification_reminder", {
          turn: ctx.turnNumber,
          turnsSinceVerification: ctx.turnNumber - getToolTracking().lastVerificationTurn,
        });
      },
    },

    {
      id: "reflection-reminder",
      name: "Reflection Reminder",
      description: "Suggest thinking if no progress for 8+ turns",
      priority: 40,
      cooldownMs: 45_000,
      enabled: true,
      lastActivated: 0,
      trigger: async (_store: BeliefStore, ctx: PolicyContext) => {
        const t = getToolTracking();
        const turnsSinceLastTool = ctx.turnNumber - t.lastToolCallTurn;
        return turnsSinceLastTool >= 8 && t.totalToolsUsed > 2;
      },
      action: async () => {
        sendWhisper(
          "8+ turns with no tool calls. Consider using /think to reflect " +
            "on progress or /finalize if the task is complete.",
        );
        onSignal("reflection_reminder", { turn: 0 });
      },
    },

    {
      id: "web-verification-hint",
      name: "Web Verification Hint",
      description: "Suggest web verification if using web beliefs without fetches",
      priority: 35,
      cooldownMs: 90_000,
      enabled: true,
      lastActivated: 0,
      trigger: async (store: BeliefStore, ctx: PolicyContext) => {
        const t = getToolTracking();
        const webBeliefs = store.query({ source: "web", maxAge: 3_600_000 });
        const turnsSinceWeb = ctx.turnNumber - t.lastWebFetchTurn;
        return webBeliefs.length > 2 && turnsSinceWeb >= 15;
      },
      action: async () => {
        sendWhisper(
          "You have recent web-based beliefs but haven't fetched " +
            "documentation in 15+ turns. Consider verifying claims " +
            "with fetch_content or browser_navigate.",
        );
        onSignal("web_verification_reminder", { turn: 0 });
      },
    },

    {
      id: "context-monitor",
      name: "Context Monitor",
      description: "Monitor token usage and warn before overflow",
      priority: 80,
      cooldownMs: 30_000,
      enabled: true,
      lastActivated: 0,
      trigger: async () => true,
      action: async (policyCtx: PolicyContext) => {
        const usage = getContextUsage(policyCtx);
        if (!usage || usage.percent === null) return;
        // PolicyContext's ContextUsage contract has percent/tokens/contextWindow
        // required; the shared accessor types them optional (other sites read a
        // subset). Values are always present per the wiring (heartbeat-scheduler
        // index.ts), so these defaults never fire — preserved from the original
        // required-typed destructure.
        const { percent = 0, tokens = 0, contextWindow = 0 } = usage;

        if (percent < USAGE_FIRED_RESET_BELOW && _firedThresholds.size > 0) {
          _firedThresholds.clear();
        }

        // Threshold ladder: soft -> advisory -> warning -> critical
        // Each threshold fires ONCE until usage resets below USAGE_FIRED_RESET_BELOW.
        // Pipeline taught fully at critical level; lighter hints below that.
        // Tier→(threshold, priority) mapping shared from
        // lib/detection/context-tiers.ts (CONTEXT_USAGE_TIERS); this policy
        // keeps its own per-tier message copy (different copy from the
        // enforcement nudge text).
        const TIER_MESSAGES: Record<"soft" | "advisory" | "warning" | "critical", string> = {
          soft: `Context at ${USAGE_WHISPER_SOFT}%. Inspect and track: context_inspect(detail="quick"). Tag with context_navigate(action="tag") to mark progress.`,
          advisory: `Context at ${USAGE_WHISPER_ADVISORY}%. Light pruning: context_inspect(detail="prune") then context_compress(action="archive") or context_navigate(action="tag") + context_compress(action="archive").`,
          warning: `Context at ${USAGE_WHISPER_WARNING}%. Deep compaction: tag + archive now. Pipeline: context_navigate(action="tag") -> context_compress(action="archive") -> compact if needed.`,
          critical: `CRITICAL: Context at ${USAGE_WHISPER_CRITICAL}%. FORCE IMMEDIATE HYGIENE. Pipeline: context_navigate(action="tag") -> context_compress(action="archive") -> context_compress(action="slide"). Do not continue work until done.`,
        };

        const thresholds: Array<{ pct: number; priority: "low" | "medium" | "high"; msg: string }> =
          CONTEXT_USAGE_TIERS.filter(
            (
              t,
            ): t is ContextUsageTierInfo & { tier: "soft" | "advisory" | "warning" | "critical" } =>
              t.tier !== "compact",
          )
            .slice()
            .reverse()
            .map((t) => ({ pct: t.threshold, priority: t.priority, msg: TIER_MESSAGES[t.tier] }));

        for (const { pct, msg } of thresholds) {
          if (percent >= pct && !_firedThresholds.has(pct)) {
            _firedThresholds.add(pct);
            sendWhisper(
              `${msg} (${tokens?.toLocaleString()} / ${contextWindow?.toLocaleString()} tokens, ${percent?.toFixed(1)}%)`,
            );
            if (pct === USAGE_WHISPER_CRITICAL) {
              const finalizationMessage =
                `[heartbeat] Context critical at ${percent?.toFixed(1)}%. ` +
                `Tag your position with context_navigate(action="tag") now and archive with context_compress(action="archive").`;
              sendSteerMessage(finalizationMessage);
              log.warn(`Auto-finalize triggered at ${USAGE_WHISPER_CRITICAL}%`);
            }
            break;
          }
        }
      },
    },
  ];
}
