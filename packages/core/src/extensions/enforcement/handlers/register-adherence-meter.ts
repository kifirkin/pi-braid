/**
 * Adherence Meter wiring — the enforcement extension's owner-facing meter.
 *
 * Three jobs, all owner-facing (nothing here may reach the agent's context):
 *   1. Count `enforcement_violation` events in-process for the session. The
 *      event is emitted for critical whispers (whisper.ts) and carries the
 *      family `rule` but no whisper source; there is no durable per-rule
 *      violation record, so this is the only honest count and it is
 *      current-session only.
 *   2. On turn_end, aggregate the active branch and escalate a rule that
 *      repeats past K to the owner over the existing TG signal seam
 *      (`WATCHDOG_TG_SIGNAL_KEY`, the same route the watchdog page uses),
 *      bounded by the milestone ladder and the per-session budget.
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
import { formatLocalTime } from "../../../lib/utils/local-time.js";
import {
  activeBranchEntries,
  aggregateRuleAdherence,
  createEscalationState,
  markEscalated,
  planEscalation,
  readSessionEntriesFromFile,
  writeAdherenceReport,
  type AdherenceEscalationState,
  type AdherenceWriteResult,
  type RuleAdherence,
} from "../../../lib/enforcement/adherence-meter.js";

const log = createLogger("adherence-meter");

/** Extension-state bucket key for the per-session meter state. */
const ADHERENCE_STATE_KEY = "adherence-meter";

/** Injectables for fixtures; production callers pass nothing. */
export interface AdherenceWiringDeps {
  now?: () => number;
  /** Owner-channel factory; defaults to the published TG signal sender. */
  sender?: () => ((text: string) => boolean | Promise<boolean>) | null;
  reportDir?: string;
  k?: number;
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

/** Compact owner ping: headline rung, source + signal, counters, provenance. */
function renderEscalation(
  rule: RuleAdherence,
  milestone: number,
  state: AdherenceEscalationState,
  ctx: ExtensionContext,
  nowMs: number,
): string {
  const signal = rule.signal.length > 140 ? `${rule.signal.slice(0, 137)}...` : rule.signal;
  const sessionId = getSessionIdSafe(ctx);
  return (
    `[adherence] rule repeating · rung ${milestone}\n` +
    `${rule.source}: "${signal}"\n` +
    `\n` +
    `deliveries ${rule.deliveries} · repeats ${rule.repeats} · suppressed ${rule.suppressions} · escalation ${state.total + 1}\n` +
    `session ${sessionId} · ${formatLocalTime(new Date(nowMs))}`
  );
}

/**
 * Aggregate the current branch and escalate every rule that crosses its next
 * milestone. Returns what fired. The rung is marked only after the owner
 * channel accepted the message, so a missing/failing channel retries on the
 * next turn instead of silently spending the rung.
 */
export async function checkAdherence(
  ctx: ExtensionContext,
  deps: AdherenceWiringDeps = {},
): Promise<{ fired: Array<{ rule: string; milestone: number }> }> {
  const state = adherenceState(ctx);
  const entries = branchEntries(ctx);
  if (entries.length === 0) return { fired: [] };

  const rules = aggregateRuleAdherence(activeBranchEntries(entries));
  const sender = (deps.sender ?? getWatchdogTgSignalSender)();
  const nowMs = (deps.now ?? Date.now)();
  const fired: Array<{ rule: string; milestone: number }> = [];

  for (const rule of rules) {
    const plan = planEscalation(state, rule.rule, rule.repeats);
    if (!plan.fire) continue;
    if (!sender) {
      log.debug(
        `[adherence] ${rule.rule} crossed rung ${plan.milestone}; no owner channel published`,
      );
      continue;
    }
    let ok = false;
    try {
      ok =
        (await Promise.resolve(
          sender(renderEscalation(rule, plan.milestone, state, ctx, nowMs)),
        )) === true;
    } catch (e) {
      log.debug(`[adherence] escalation send threw for ${rule.rule}: ${(e as Error).message}`);
    }
    if (!ok) {
      log.debug(`[adherence] escalation not delivered for ${rule.rule}; rung stays unspent`);
      continue;
    }
    markEscalated(state, rule.rule);
    fired.push({ rule: rule.rule, milestone: plan.milestone });
  }
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
