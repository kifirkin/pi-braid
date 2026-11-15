/**
 * Adherence Meter wiring — the enforcement extension's owner-facing meter.
 *
 * Three jobs, all owner-facing (nothing here may reach the agent's context):
 *   1. Count `enforcement_violation` events in-process for the session. The
 *      event is emitted for critical whispers (whisper.ts) and carries the
 *      family `rule` but no whisper source; there is no durable per-rule
 *      violation record, so this is the only honest count and it is
 *      current-session only.
 *   2. On turn_end, aggregate the active branch and report a rule that repeats
 *      past K to the owner over the existing TG signal seam
 *      (`WATCHDOG_TG_SIGNAL_KEY`, the same route the watchdog page uses), as at
 *      most ONE digest per hour that states how many crossings it folded. The
 *      milestone ladder and the per-session budget are unchanged: a crossing is
 *      still planned by `planEscalation` and its rung is still spent only when
 *      the digest was accepted.
 *   3. On session shutdown, append the owner report
 *      (`~/.pi/agent/braid/adherence/report.jsonl`).
 *
 * The meter never sends a tracked message, never registers a tool, and the
 * report is read by nothing that composes the prompt.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createLogger } from "../../../lib/core/logger.js";
import { SESSION_SHUTDOWN } from "../../../lib/core/event-names.js";
import { eventBus, type EnforcementEvent } from "../../../lib/events/event-bus.js";
import { registerTurnEndHandler } from "../../../lib/events/turn-end-coordinator.js";
import {
  registerSessionStartHandler,
  SessionPhase,
} from "../../../lib/state/session-start-queue.js";
import {
  getExtensionState,
  getSessionIdSafe,
  safeSessionManagerTyped,
} from "../../../lib/state/extension-state.js";
import { getWatchdogTgSignalSender } from "../../../lib/state/global-state.js";
import { readTelegramPollerLiveness } from "../../../lib/state/telegram-poller-liveness.js";
import { formatLocalTime } from "../../../lib/utils/local-time.js";
import {
  activeBranchEntries,
  aggregateRuleAdherence,
  commitDigest,
  createEscalationState,
  planDigest,
  planEscalation,
  readSessionEntriesFromFile,
  recordEscalation,
  writeAdherenceReport,
  type AdherenceEscalationState,
  type AdherenceWriteResult,
  type PendingEscalation,
} from "../../../lib/enforcement/adherence-meter.js";

const log = createLogger("adherence-meter");

/** Extension-state bucket key for the per-session meter state. */
const ADHERENCE_STATE_KEY = "adherence-meter";

/** What a crossing may ask the owner channel for. */
export interface AdherenceOwnerSender {
  (
    text: string,
    opts?: {
      parseMode?: "HTML" | "Markdown";
      source?: string;
      /** Escalations folded into this message instead of sent one by one. */
      suppressed?: number;
    },
  ): boolean | Promise<boolean>;
}

/** Injectables for fixtures; production callers pass nothing. */
export interface AdherenceWiringDeps {
  now?: () => number;
  /** Owner-channel factory; defaults to the published TG signal sender. */
  sender?: () => AdherenceOwnerSender | null;
  /**
   * True when THIS session is the one that reads the owner's chat. Defaults to
   * the Telegram poller's live state (the seat that owns the poller is the seat
   * whose escalations the owner must hear). A second seat shares the bot token
   * but not the conversation, and its escalations never become owner messages;
   * a spawned seat registers no Telegram surface at all, so it publishes no
   * sender either.
   */
  ownerSession?: () => boolean;
  /** How often the owner may receive a digest (default one hour). */
  digestWindowMs?: number;
  reportDir?: string;
  k?: number;
}

/**
 * Owner-facing session predicate. The liveness probe is core's own registry
 * (`telegram-poller-liveness.ts`): "running" or "unknown" means no other seat
 * is holding the owner's inbound channel, "stopped" means this process loaded
 * Telegram and its poller is not the one reading the chat.
 */
function isOwnerChannelSession(): boolean {
  return readTelegramPollerLiveness() !== "stopped";
}

function adherenceState(ctx: ExtensionContext): AdherenceEscalationState {
  return getExtensionState(ctx, ADHERENCE_STATE_KEY, createEscalationState);
}

/** Active-branch entries from the session manager; [] when unavailable. */
function branchEntries(ctx: ExtensionContext): unknown[] {
  try {
    const branch = safeSessionManagerTyped(ctx)?.getBranch?.();
    return Array.isArray(branch) ? branch : [];
  } catch {
    return [];
  }
}

/** Escape the three characters Telegram's HTML parser reserves. */
function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** The rule's own text: the key is `source::body`, and the body is the rule. */
function ruleText(entry: PendingEscalation): string {
  const body = entry.ruleKey.includes("::")
    ? entry.ruleKey.split("::").slice(1).join("::")
    : entry.ruleKey;
  return body.trim();
}

/** Counts up to twenty in words; past that the numeral is the honest form. */
const COUNT_WORDS = [
  "zero",
  "one",
  "two",
  "three",
  "four",
  "five",
  "six",
  "seven",
  "eight",
  "nine",
  "ten",
  "eleven",
  "twelve",
  "thirteen",
  "fourteen",
  "fifteen",
  "sixteen",
  "seventeen",
  "eighteen",
  "nineteen",
  "twenty",
];

function countWord(n: number): string {
  return Number.isInteger(n) && n >= 0 && n < COUNT_WORDS.length ? COUNT_WORDS[n] : String(n);
}

/** The same word, as the opening of a sentence. */
function sentenceCase(text: string): string {
  return text.length > 0 ? `${text[0].toUpperCase()}${text.slice(1)}` : text;
}

/**
 * A rule body that already carries its own quoting is not quoted twice: the
 * whisper bodies the meter counts open and close with quotation marks of their
 * own.
 */
function quoted(text: string): string {
  const opens = /^["'“«]/.test(text);
  const closes = /["'”»]$/.test(text);
  return opens && closes ? text : `"${text}"`;
}

/**
 * The hourly digest: one thing that happened, not a field dump. A bold subject
 * names the rung and how many rules the message is about; one sentence carries
 * the counts and the rule it quotes; one stamp says when.
 *
 * Two fields the labelled body carried are deliberately gone:
 *   - the truncated session id, because the message already opens with the
 *     identity label, and the label names the session the send belongs to
 *     (`lib/identity.ts`, telegram);
 *   - the report path. The report is where the counts live, not somewhere a
 *     reader navigates to from a chat client, so an operator path on the last
 *     line was one of the labelled fields the owner read as a dump.
 *
 * The rule is quoted in FULL, never clipped: a fragment of a regex told the
 * owner nothing, and the outbound gate carries a formatted body rather than
 * asking a sender to pre-chew its subject. The quietest honest count of the
 * crossings it folded is stated in its own sentence, so a digest that carries
 * several never reads like a single one.
 */
export function renderAdherenceDigest(
  digest: { pending: PendingEscalation[]; suppressed: number },
  nowMs: number,
): string {
  // The subject is the rule at the highest rung in the digest. Among rules the
  // ladder put on the same rung (it advances one rung per pass, so a tie is the
  // ordinary case for a folded digest), the one with the most deliveries is the
  // informative quote.
  const subject = digest.pending.reduce((best, entry) =>
    entry.milestone > best.milestone ||
    (entry.milestone === best.milestone && entry.deliveries >= best.deliveries)
      ? entry
      : best,
  );
  const crossings = digest.pending.length;
  const ruleCount = new Set(digest.pending.map((entry) => entry.ruleKey)).size;
  const rules = ruleCount === 1 ? "rule" : "rules";
  const folded =
    crossings > 1
      ? sentenceCase(
          `${countWord(crossings)} crossings, from ${countWord(ruleCount)} ${rules}, ` +
            `are reported together in this message. `,
        )
      : "";
  return [
    `<b>Adherence · rung ${subject.milestone} · ${countWord(ruleCount)} ${rules}</b>`,
    `${folded}The rule ${escapeHtml(quoted(ruleText(subject)))} ` +
      `(${escapeHtml(subject.source)}) has repeated ${subject.repeats} ` +
      `times across ${subject.deliveries} deliveries.`,
    `at ${formatLocalTime(new Date(nowMs))}`,
  ].join("\n");
}

/**
 * Aggregate the current branch and fold every crossing into the owner's
 * hourly digest.
 *
 * What did NOT change: the ladder. `planEscalation` is asked exactly as before,
 * and a rung is still spent only when the owner channel accepted the message
 * that reported it, so the milestones, thresholds and detection are untouched.
 *
 * What changed: a crossing is buffered (`recordEscalation`) and delivered as
 * ONE digest per window (`planDigest`), which states how many crossings it
 * folded instead of sending each one as its own message. Two seats sharing a
 * bot token no longer both write into the owner's chat: only the session that
 * owns the inbound channel escalates.
 */
export async function checkAdherence(
  ctx: ExtensionContext,
  deps: AdherenceWiringDeps = {},
): Promise<{ fired: Array<{ rule: string; milestone: number }> }> {
  const state = adherenceState(ctx);
  const entries = branchEntries(ctx);
  const rules = entries.length > 0 ? aggregateRuleAdherence(activeBranchEntries(entries)) : [];
  const sender = (deps.sender ?? getWatchdogTgSignalSender)();
  const nowMs = (deps.now ?? Date.now)();
  const sessionId = getSessionIdSafe(ctx);

  for (const rule of rules) {
    const plan = planEscalation(state, rule.rule, rule.repeats);
    if (!plan.fire) continue;
    recordEscalation(state, {
      ruleKey: rule.rule,
      rung: (state.rules[rule.rule]?.rung ?? 0) + 1,
      milestone: plan.milestone,
      source: rule.source,
      deliveries: rule.deliveries,
      repeats: rule.repeats,
      sessionId,
      at: nowMs,
    });
  }

  const buffered = state.pending ?? [];
  if (buffered.length === 0) return { fired: [] };
  if (!sender) {
    log.debug(`[adherence] ${buffered.length} escalation(s) buffered; no owner channel published`);
    return { fired: [] };
  }
  if (!(deps.ownerSession ?? isOwnerChannelSession)()) {
    log.debug(
      `[adherence] ${buffered.length} escalation(s) buffered; this session does not own the owner channel`,
    );
    return { fired: [] };
  }
  const digest = planDigest(state, nowMs, {
    ...(deps.digestWindowMs !== undefined ? { windowMs: deps.digestWindowMs } : {}),
  });
  if (!digest.send) {
    log.debug(
      `[adherence] ${digest.pending.length} escalation(s) buffered; digest window closed (${digest.suppressed} suppressed so far)`,
    );
    return { fired: [] };
  }

  let ok = false;
  try {
    ok =
      (await Promise.resolve(
        sender(renderAdherenceDigest(digest, nowMs), {
          parseMode: "HTML",
          source: "adherence-digest",
          suppressed: digest.suppressed,
        }),
      )) === true;
  } catch (e) {
    log.debug(`[adherence] digest send threw: ${(e as Error).message}`);
  }
  if (!ok) {
    log.debug("[adherence] digest not delivered; crossings stay buffered, rungs unspent");
    return { fired: [] };
  }
  const fired = digest.pending.map((entry) => ({
    rule: entry.ruleKey,
    milestone: entry.milestone,
  }));
  commitDigest(state, nowMs);
  log.debug(
    `[adherence] digest delivered: ${fired.length} crossing(s), ${digest.suppressed} suppressed`,
  );
  return { fired };
}

/**
 * Build + write the session-end report. Prefers the in-memory branch (the
 * live source of truth at shutdown) and falls back to the session file.
 */
export function finalizeAdherence(
  ctx: ExtensionContext,
  deps: AdherenceWiringDeps = {},
): AdherenceWriteResult {
  const sm = safeSessionManagerTyped(ctx);
  const sessionFile = sm?.getSessionFile?.() ?? "";
  const sessionId = getSessionIdSafe(ctx);
  const branch = sm?.getBranch?.();
  const entries =
    Array.isArray(branch) && branch.length > 0
      ? branch
      : sessionFile
        ? readSessionEntriesFromFile(sessionFile)
        : [];
  return writeAdherenceReport(
    { entries, sessionId, sessionFile, cwd: ctx.cwd, escalation: adherenceState(ctx) },
    { now: deps.now, reportDir: deps.reportDir, k: deps.k },
  );
}

/** Violation listener slot; module-level because the event bus has no ctx. */
let violationListener: ((event: EnforcementEvent) => void) | undefined;

/**
 * Register the meter: session-start violation listener (reload-safe),
 * turn-end escalation check, session-shutdown report.
 */
export function registerAdherenceMeter(pi: ExtensionAPI): void {
  registerSessionStartHandler(
    pi,
    SessionPhase.Background,
    async (_event: unknown, ctx: ExtensionContext) => {
      if (violationListener) eventBus.off("enforcement_violation", violationListener);
      violationListener = (event) => {
        try {
          const state = adherenceState(ctx);
          const rule = typeof event?.rule === "string" && event.rule ? event.rule : "enforcement";
          state.violations[rule] = (state.violations[rule] ?? 0) + 1;
        } catch {
          // counting must never break the emitting path
        }
      };
      eventBus.on("enforcement_violation", violationListener);
    },
    "adherence-meter-violations",
  );

  registerTurnEndHandler("adherence-meter", 40, async (_event, ctx) => {
    try {
      await checkAdherence(ctx);
    } catch (e) {
      log.warn(`[adherence] turn-end check failed: ${(e as Error).message}`);
    }
  });

  pi.on(SESSION_SHUTDOWN, (_event, ctx) => {
    try {
      if (violationListener) {
        eventBus.off("enforcement_violation", violationListener);
        violationListener = undefined;
      }
      const result = finalizeAdherence(ctx);
      if (result.ok) log.debug(`[adherence] report written: ${result.path}`);
      else log.warn(`[adherence] report not written: ${result.error}`);
    } catch (e) {
      log.warn(`[adherence] shutdown report failed: ${(e as Error).message}`);
    }
  });
}
