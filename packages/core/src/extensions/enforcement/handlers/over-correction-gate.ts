/**
 * Over-correction gate — accusation-triggered irreversible-action gate.
 *
 * A later message that blames already-completed work for a live failure can
 * push an agent to damage correct work; the decisive fact usually sits
 * outside the workspace (arXiv 2609.32616, interventions I2/I3). The gate
 * withholds a conservative set of destructive calls while either arming path
 * is live:
 *
 *   - an accusation in the recent transcript: a real user or injected/peer
 *     message asserting that completed work caused a live failure, or asking
 *     to undo it;
 *   - a hot acceptance signal published by the sycophancy detector
 *     (ACCEPTANCE_SIGNAL_KEY in lib/state/global-state.ts).
 *
 * Modes: braid.enforcement.overCorrectionGate.mode — "off" (default, inert),
 * "shadow" (whisper + log, never blocks), "on" (block, with the reason naming
 * the missing evidence and the exits).
 *
 * Lift: transcript-derived and stateless. The block lifts when the latest
 * real user message is a strict owner confirmation (EN/RU) and an accusation
 * inbound message strictly precedes it — the owner spoke again after the
 * block. Presenting new workspace evidence is the paper's other exit; no
 * clean mechanical proxy for it exists at this seam, so only the confirmation
 * exit is honored today.
 *
 * Every failure path fails open: log and return not-blocked.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getDeliverablesFilePath } from "../../../lib/config/braid-paths.js";
import { getOverCorrectionGateConfig } from "../../../lib/config/braid-settings.js";
import { createLogger } from "../../../lib/core/logger.js";
import { getSessionIdSafe, safeSessionManagerTyped } from "../../../lib/state/extension-state.js";
import { getAcceptanceSignal } from "../../../lib/state/global-state.js";
import type { SessionEntry } from "../../../lib/state/session-manager.js";
import { sendEnforcementWhisper } from "../whisper.js";

const log = createLogger("enforcement:over-correction-gate");

// Pinned tuning

/** How many recent inbound messages the accusation matcher scans. */
export const ACCUSATION_LOOKBACK_INBOUND = 3;

/** An acceptance signal older than this is cold (10 minutes). */
export const ACCEPTANCE_HOT_WINDOW_MS = 10 * 60 * 1000;

/** Accusation scan cap: long messages cannot blow the regex cost. */
export const ACCUSATION_SCAN_MAX_CHARS = 4000;

/** Result shape of the gate check, mirroring checkBlocking's seam. */
export interface GateResult {
  blocked: boolean;
  reason: string;
}

const NOT_BLOCKED: GateResult = { blocked: false, reason: "" };

// Accusation matcher (EN + RU, conservative)

// Work nouns the matcher will tie a harm claim to. Deliberately excludes
// generic artifacts ("build", "release") whose failure is often a neutral
// report rather than an accusation of the agent's completed work.
const WORK_EN =
  "(?:change|changes|fix|fixes|patch|patches|edit|edits|update|updates|" +
  "commit|commits|merge|merges|deploy|deploys|deployment|deployments|" +
  "migration|migrations|refactor|rewrite|work|code|pr|diff)";

// Affirmative harm forms only: bare infinitives ("break", "cause", "fail")
// are excluded so negated reports ("didn't break", "did not cause") cannot
// match by vocabulary. `(?<!not\s)` guards the remaining forms.
const HARM_EN =
  "(?<!not\\s)(?:broke|broken|breaks|damaged|ruined|killed|caused|causing|" +
  "fails|failing|failed|failure|regression|crash|crashes|crashed|error|errors|" +
  "outage|incident|down)";

const UNDO_EN = "(?<!do not\\s)(?<!don'?t\\s)(?<!never\\s)(?:revert|rollback|roll back|undo)";
const DET_EN = "(?:your|the|that|this|these|those|last|previous|my)";

// One word token; the qualifier run is the bounded gap (up to two tokens)
// that may sit between a determiner and the work noun it owns ("your timeout
// change") while the harm conjunct after the noun stays required. The same
// token class bounds the object of a roll-back request ("Roll the timeout
// back").
const WORD_EN = "[a-z][\\w'’-]*";
const QUALIFIER_RUN_EN = `(?:\\s+${WORD_EN}){0,2}`;

// Russian work nouns and harm stems (no \b: JS word boundaries are ASCII-only).
const WORK_RU = "изменени|фикс|коммит|правк|патч|мердж|депло|работ|код|сборк";
const HARM_RU =
  "(?<!не\\s)(?:слома|лома|испортил|погубил|уронил|привёл|привел|вызвал|" +
  "регресс|ошибк|пада|упал|авари|инцидент|баг)";

/** Accusation patterns. Every pattern is pinned by a test. */
export const ACCUSATION_PATTERNS: Array<{ id: string; re: RegExp }> = [
  {
    id: "en-work-caused-harm",
    re: new RegExp(
      `\\b(?:your|the|that|this|these|those)${QUALIFIER_RUN_EN}\\s+${WORK_EN}\\b[\\s\\S]{0,80}?\\b${HARM_EN}\\b`,
      "i",
    ),
  },
  {
    id: "en-you-caused-harm",
    re: /\byou\s+(?<!not\s)(?:broke|broken|damaged|ruined|killed|caused|are causing|have caused)\b/i,
  },
  {
    id: "en-harm-by-work",
    re: new RegExp(
      `\\b${HARM_EN}\\b\\s+by\\s+(?:your|the|that|this)(?:\\s+(?:last|previous|earlier|recent|latest))?\\s+${WORK_EN}\\b`,
      "i",
    ),
  },
  {
    id: "en-introduced-harm",
    re: /\bintroduced\s+(?:a\s+|the\s+)?(?:regression|bug|failure|error|problem|issue)\b/i,
  },
  {
    id: "en-undo-request",
    re: new RegExp(
      `\\b${UNDO_EN}\\b[\\s\\S]{0,40}?\\b${DET_EN}\\b[\\s\\S]{0,40}?\\b${WORK_EN}\\b`,
      "i",
    ),
  },
  {
    // "Roll the timeout back" / "Roll back the timeout": the object is a
    // determiner phrase naming what to undo, so it need not itself be a work
    // noun.
    id: "en-undo-roll-back",
    re: new RegExp(
      `\\b(?<!do not\\s)(?<!don'?t\\s)(?<!never\\s)roll\\b(?:` +
        `\\s+${DET_EN}\\s+${WORD_EN}(?:\\s+${WORD_EN})?\\s+back\\b` +
        `|\\s+back\\s+${DET_EN}\\s+${WORD_EN}(?:\\s+${WORD_EN})?` +
        `)`,
      "i",
    ),
  },
  {
    id: "en-undo-it",
    re: new RegExp(
      `\\b${UNDO_EN}\\b[\\s\\S]{0,20}?\\b(?:it|everything|all of it|the whole thing)\\b`,
      "i",
    ),
  },
  {
    id: "ru-work-caused-harm",
    re: /(?:из-за|из за|после)\s+тво(?:их|его|ей|её)\s+(?:изменени|фикс|коммит|правк|патч|мердж|депло|работ|код|сборк)/i,
  },
  {
    id: "ru-your-work-harmed",
    re: new RegExp(
      `тво(?:й|я|е|и|их|его|ей|её)\\s+(?:${WORK_RU})[а-яё]*[\\s\\S]{0,80}?${HARM_RU}`,
      "i",
    ),
  },
  {
    id: "ru-undo-request",
    re: /(?<!не\s)(?:откати|откатить|откатывай|верни|вернуть|возвращай|убери|убрать|удали|удалить)(?=$|[^а-яё])[\s\S]{0,30}?(?:всё|все|это|его|их|свои|твои|эти|последни|как было|изменения|фикс|коммит|правк|патч|мердж|деплой)/i,
  },
];

/** True when a message asserts completed work caused harm, or asks to undo it. */
export function isAccusation(text: string): boolean {
  if (!text) return false;
  const t = text.slice(0, ACCUSATION_SCAN_MAX_CHARS);
  for (const p of ACCUSATION_PATTERNS) {
    if (p.re.test(t)) return true;
  }
  return false;
}

// Owner confirmation matcher (strict, EN + RU)

/** Confirmation patterns. Every pattern is pinned by a test. */
export const CONFIRMATION_PATTERNS: Array<{ id: string; re: RegExp }> = [
  { id: "en-i-confirm", re: /\bi\s+confirm\b/i },
  { id: "en-confirmed", re: /(?<!not\s)(?<!cannot\s)\bconfirmed\b(?=\s*(?:[.,;!]|$))/i },
  {
    id: "en-yes-proceed",
    re: /\byes,?\s+(?:please\s+)?(?:proceed|go ahead|do it|go for it|revert|undo|delete|remove|restore|reset|roll back|rollback)\b/i,
  },
  { id: "ru-confirm", re: /(?<!не\s)подтверждаю/ },
  {
    id: "ru-yes-imperative",
    re: /да,?\s+(?:делай|выполняй|откатывай|удаляй|продолжай|приступай)(?=$|[^а-яё])/i,
  },
];

/** True when the text is a strict second-confirmation from the owner. */
export function isOwnerConfirmation(text: string): boolean {
  if (!text) return false;
  const t = text.slice(0, ACCUSATION_SCAN_MAX_CHARS);
  for (const p of CONFIRMATION_PATTERNS) {
    if (p.re.test(t)) return true;
  }
  return false;
}

// Destructive matcher

export interface DestructiveMatch {
  label: string;
}

const GIT_SUBS = new Set(["reset", "checkout", "restore", "revert", "branch", "clean"]);

/** Split a shell command on top-level && || ; | and newlines (quote-aware). */
function shellSegments(command: string): string[] {
  const segments: string[] = [];
  let cur = "";
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (quote) {
      cur += ch;
      if (ch === "\\" && quote === '"') {
        cur += command[i + 1] ?? "";
        i++;
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      cur += ch;
      continue;
    }
    if ((ch === "&" || ch === "|") && command[i + 1] === ch) {
      segments.push(cur);
      cur = "";
      i++;
      continue;
    }
    if (ch === ";" || ch === "|" || ch === "\n") {
      segments.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  segments.push(cur);
  return segments.map((s) => s.trim()).filter(Boolean);
}

/** Tokenize one shell segment, dropping quote characters. */
function shellTokens(segment: string): string[] {
  const tokens: string[] = [];
  let cur = "";
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < segment.length; i++) {
    const ch = segment[i];
    if (quote) {
      if (ch === "\\" && quote === '"') {
        cur += segment[i + 1] ?? "";
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
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === " " || ch === "\t") {
      if (cur) {
        tokens.push(cur);
        cur = "";
      }
      continue;
    }
    cur += ch;
  }
  if (cur) tokens.push(cur);
  return tokens;
}

/** Repo root for a cwd, or null when not inside a git worktree. */
function resolveRepoRoot(cwd: string): string | null {
  try {
    const out = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd,
      encoding: "utf-8",
      timeout: 5000,
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    if (!out) return null;
    try {
      return realpathSync(out);
    } catch {
      return out;
    }
  } catch {
    return null;
  }
}

/** Canonical cwd (macOS /var vs /private/var): target paths must match git's. */
function canonicalCwd(cwd: string): string {
  try {
    return realpathSync(cwd);
  } catch {
    return cwd;
  }
}

/** Paths recorded in the project's deliverables manifest (last 100 records). */
function readManifestPaths(repoRoot: string): Set<string> {
  const out = new Set<string>();
  try {
    const manifestPath = getDeliverablesFilePath(repoRoot);
    if (!existsSync(manifestPath)) return out;
    const lines = readFileSync(manifestPath, "utf-8").split("\n").filter(Boolean);
    for (const line of lines.slice(-100)) {
      try {
        const record = JSON.parse(line) as { files?: Array<{ path?: unknown }> };
        for (const f of record.files ?? []) {
          if (typeof f?.path === "string" && f.path) out.add(f.path);
        }
      } catch {
        // malformed manifest line — skip it, the leg stays best-effort
      }
    }
  } catch {
    // manifest unreadable — no manifest leg
  }
  return out;
}

/** True when the absolute path is a git-tracked file or a manifest deliverable. */
function isTrackedOrManifest(repoRoot: string, absPath: string): boolean {
  const rel = path.relative(repoRoot, absPath);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return false;
  try {
    execFileSync("git", ["ls-files", "--error-unmatch", "--", rel], {
      cwd: repoRoot,
      encoding: "utf-8",
      timeout: 5000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return true;
  } catch {
    // not tracked (or not a repo) — fall through to the manifest leg
  }
  return readManifestPaths(repoRoot).has(rel);
}

/** Match a git segment against the destructive set; null when benign. */
function matchGitSegment(tokens: string[]): DestructiveMatch | null {
  const bin = tokens[0];
  if (!(bin === "git" || bin.endsWith("/git"))) return null;
  let subIdx = -1;
  for (let i = 1; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.startsWith("-")) continue;
    if (GIT_SUBS.has(t)) {
      subIdx = i;
      break;
    }
  }
  if (subIdx < 0) return null;
  const sub = tokens[subIdx];
  const rest = tokens.slice(subIdx + 1);
  const flags = rest.filter((t) => t.startsWith("-"));
  switch (sub) {
    case "reset":
      return flags.includes("--hard") ? { label: "git reset --hard" } : null;
    case "checkout": {
      // Path-restoring forms only (`git checkout -- <path>` /
      // `git checkout <ref> -- <path>`); branch navigation has no `--`.
      const sep = rest.indexOf("--");
      if (sep < 0) return null;
      const paths = rest.slice(sep + 1).filter((t) => t && !t.startsWith("-"));
      return paths.length > 0 ? { label: `git checkout -- <path> (${paths.join(" ")})` } : null;
    }
    case "restore":
      return { label: "git restore" };
    case "revert":
      return { label: "git revert" };
    case "branch":
      return flags.includes("-D") ? { label: "git branch -D" } : null;
    case "clean": {
      const forced = flags.some((f) => f === "--force" || /^-[a-zA-Z]*f[a-zA-Z]*$/.test(f));
      return forced ? { label: "git clean -f" } : null;
    }
    default:
      return null;
  }
}

/** Match an rm segment whose targets resolve to tracked/manifest files. */
function matchRmSegment(tokens: string[], cwd: string): DestructiveMatch | null {
  const bin = tokens[0];
  if (!(bin === "rm" || bin.endsWith("/rm"))) return null;
  const targets = tokens.slice(1).filter((t) => t !== "--" && !t.startsWith("-"));
  if (targets.length === 0) return null;
  const repoRoot = resolveRepoRoot(cwd);
  if (!repoRoot) return null;
  const base = canonicalCwd(cwd);
  const hits: string[] = [];
  for (const target of targets) {
    // Shell expansions cannot be resolved statically — never guess.
    if (/[*?[\]{}~$`]/.test(target)) continue;
    const abs = path.resolve(base, target);
    if (isTrackedOrManifest(repoRoot, abs)) hits.push(target);
  }
  return hits.length > 0 ? { label: `rm of tracked file(s): ${hits.join(", ")}` } : null;
}

/**
 * Classify a bash command against the conservative destructive set.
 * Repo resolution runs only after an rm candidate was found.
 */
export function matchDestructiveBash(
  command: string,
  cwd: string = process.cwd(),
): DestructiveMatch | null {
  if (!command) return null;
  for (const segment of shellSegments(command)) {
    const tokens = shellTokens(segment);
    if (tokens.length === 0) continue;
    const hit = matchGitSegment(tokens) ?? matchRmSegment(tokens, cwd);
    if (hit) return hit;
  }
  return null;
}

/**
 * Classify a write call: emptying an existing tracked (or manifest) file.
 * Repo resolution runs only after the emptying pattern was found.
 */
export function matchDestructiveWrite(
  input: Record<string, unknown> | undefined,
  cwd: string = process.cwd(),
): DestructiveMatch | null {
  const filePath = (input?.path as string) ?? (input?.target as string);
  const content = input?.content;
  if (typeof filePath !== "string" || !filePath) return null;
  if (typeof content !== "string" || content.trim() !== "") return null;
  const abs = path.resolve(canonicalCwd(cwd), filePath);
  try {
    if (!statSync(abs).isFile()) return null;
  } catch {
    return null;
  }
  const repoRoot = resolveRepoRoot(cwd);
  if (!repoRoot) return null;
  if (!isTrackedOrManifest(repoRoot, abs)) return null;
  const rel = path.relative(repoRoot, abs);
  return { label: `emptying tracked file ${rel}` };
}

// Transcript helpers

interface InboundMessage {
  text: string;
  atMs: number;
  fromUser: boolean;
}

function textFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter(
      (c): c is { type: string; text?: string } =>
        !!c && typeof c === "object" && (c as { type?: unknown }).type === "text",
    )
    .map((c) => (typeof c.text === "string" ? c.text : ""))
    .join("\n");
}

function tsMs(ts: string | undefined): number {
  const t = Date.parse(ts ?? "");
  return Number.isFinite(t) ? t : 0;
}

/** The last `limit` inbound messages (real user + injected/peer), oldest first. */
function collectInbound(branch: SessionEntry[], limit: number): InboundMessage[] {
  const out: InboundMessage[] = [];
  for (let i = branch.length - 1; i >= 0 && out.length < limit; i--) {
    const entry = branch[i] as {
      type?: string;
      timestamp?: string;
      message?: unknown;
      content?: unknown;
    };
    if (entry?.type === "message") {
      const msg = entry.message as { role?: unknown; content?: unknown } | undefined;
      if (!msg || msg.role !== "user") continue;
      const text = textFromContent(msg.content);
      if (!text) continue;
      out.push({ text, atMs: tsMs(entry.timestamp), fromUser: true });
    } else if (entry?.type === "custom_message") {
      const text = textFromContent(entry.content);
      if (!text) continue;
      // Machine-generated whispers are system signals, not injected/peer
      // traffic — they carry the universal envelope and never accuse.
      if (text.trimStart().startsWith("[braid-whisper")) continue;
      out.push({ text, atMs: tsMs(entry.timestamp), fromUser: false });
    }
  }
  return out.reverse();
}

/** The latest real user message, or null. */
function latestUserMessage(branch: SessionEntry[]): InboundMessage | null {
  for (let i = branch.length - 1; i >= 0; i--) {
    const entry = branch[i] as { type?: string; timestamp?: string; message?: unknown };
    if (entry?.type !== "message") continue;
    const msg = entry.message as { role?: unknown; content?: unknown } | undefined;
    if (!msg || msg.role !== "user") continue;
    const text = textFromContent(msg.content);
    if (!text) continue;
    return { text, atMs: tsMs(entry.timestamp), fromUser: true };
  }
  return null;
}

/** Acceptance signal is hot: present, recent, and from this session. */
function acceptanceHot(ctx: ExtensionContext, nowMs: number): boolean {
  const signal = getAcceptanceSignal();
  if (!signal) return false;
  if (nowMs - signal.atMs > ACCEPTANCE_HOT_WINDOW_MS) return false;
  const sid = getSessionIdSafe(ctx);
  if (signal.sessionId && signal.sessionId !== "?" && sid !== "?" && signal.sessionId !== sid) {
    return false;
  }
  return true;
}

// Gate

function truncate(text: string, max: number): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

function buildBlockReason(label: string, trigger: string): string {
  return (
    `Over-correction gate: blocked a destructive call (${label}) — ${trigger}. ` +
    `The decisive fact is not in the workspace, so the accusation cannot be settled locally. ` +
    `To proceed: present new, independently checkable workspace evidence, or have the owner ` +
    `confirm the reversal in a new message (EN "I confirm" / "yes, proceed"; ` +
    `RU "подтверждаю" / "да, делай"). This gate currently lifts only on the owner confirmation.`
  );
}

function evaluate(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  toolName: string,
  input: Record<string, unknown> | undefined,
): GateResult {
  const { mode } = getOverCorrectionGateConfig();
  if (mode === "off") return NOT_BLOCKED; // inert: before any matching work

  const sm = safeSessionManagerTyped(ctx) as { getBranch?: () => SessionEntry[] } | undefined;
  const branch = sm?.getBranch?.() ?? null;
  if (!branch) return NOT_BLOCKED; // no transcript → cannot arm or lift → fail open

  const nowMs = Date.now();
  const inbound = collectInbound(branch, ACCUSATION_LOOKBACK_INBOUND);
  const accusation = inbound.find((m) => isAccusation(m.text)) ?? null;
  if (!accusation && !acceptanceHot(ctx, nowMs)) return NOT_BLOCKED;

  const cwd = (ctx as { cwd?: string }).cwd ?? process.cwd();
  const destructive =
    toolName === "bash"
      ? matchDestructiveBash(typeof input?.command === "string" ? input.command : "", cwd)
      : toolName === "write"
        ? matchDestructiveWrite(input, cwd)
        : null;
  if (!destructive) return NOT_BLOCKED;

  // Lift: the owner spoke again after the block. Stateless — the latest real
  // user message must be a strict confirmation and an accusation must strictly
  // precede it (a confirmation inside the accusation message does not count).
  const latestUser = latestUserMessage(branch);
  if (
    latestUser &&
    isOwnerConfirmation(latestUser.text) &&
    inbound.some((m) => m.fromUser && m.atMs < latestUser.atMs && isAccusation(m.text))
  ) {
    log.info(`lifted by owner confirmation (${destructive.label})`);
    return NOT_BLOCKED;
  }

  const trigger = accusation
    ? `recent accusation: "${truncate(accusation.text, 140)}"`
    : "a hot acceptance signal from the sycophancy detector";

  if (mode === "shadow") {
    const message =
      `over-correction gate [shadow]: would block ${destructive.label} — ${trigger}. ` +
      `No block applied (mode "shadow").`;
    log.warn(message);
    sendEnforcementWhisper(pi, ctx, message);
    return NOT_BLOCKED;
  }

  // mode === "on"
  log.warn(`blocked ${toolName}: ${destructive.label} — ${trigger}`);
  return { blocked: true, reason: buildBlockReason(destructive.label, trigger) };
}

/**
 * Check the over-correction gate for a proposed tool call. Called from the
 * tool-call seam immediately after checkBlocking. Never throws.
 */
export function checkOverCorrectionGate(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  toolName: string,
  input: Record<string, unknown> | undefined,
): GateResult {
  try {
    return evaluate(pi, ctx, toolName, input);
  } catch (err) {
    log.warn(
      `over-correction gate failed open: ${err instanceof Error ? err.message : String(err)}`,
    );
    return NOT_BLOCKED;
  }
}
