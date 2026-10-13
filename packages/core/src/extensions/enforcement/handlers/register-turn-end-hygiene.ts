/**
 * register-turn-end-hygiene - Context hygiene on every turn_end.
 *
 * Fires on EVERY turn_end (not just when tools were called):
 *   1. Checks context usage -- if high, emit hygiene whispers
 *   2. Arms the hygiene act at token arms of the resolved window (act at
 *      min(0.60W, 130k), hard backstop at 0.90W) with a pre-save safety net (flush
 *      scratchpad + write resume.json) to guarantee zero data loss.
 *
 * Safety gates, checked in order:
 *   - Loop-done gate: the act never fires on a turn_end whose assistant
 *     stopReason is "toolUse" -- the agent loop is live (the next model
 *     call is pending) and ctx.compact() aborts it mid-run (manual
 *     compaction never retries or continues the interrupted turn). The
 *     only exception is the 0.90W backstop, which deliberately stops a
 *     runaway loop before overflow.
 *   - Mode awareness: the DETERMINISTIC slide path carries none of the
 *     abort/corruption risk that justifies standing down, so it fires at
 *     the act arm regardless of pi's compaction.enabled. Only the LLM
 *     summarize path is mode-gated: with pi's compaction.enabled (re-read
 *     per act decision from the merged settings), native compaction owns
 *     LLM compaction and the act stands down to nudge-only.
 *
 * ctx.compact() calls this._disconnectFromAgent() + this.abort() in pi-core
 * (agent-session.js:1245). To keep the handler's synchronous part off the
 * abort path, the compact call is deferred via setTimeout(0). Resume after
 * the compaction is register-session-compact's decision, not ours.
 *
 * Discoverability (scratchpad/memory/episodes surfacing) fires from
 * SESSION_START (register-session-start-discoverability.ts), before the
 * first turn.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { SettingsManager, getAgentDir } from "@earendil-works/pi-coding-agent";
import { existsSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import * as path from "node:path";
import { execSync } from "node:child_process";
import { createLogger } from "../../../lib/core/logger.js";
import { registerTurnEndHandler } from "../../../lib/events/turn-end-coordinator.js";
import { sendEnforcementWhisper } from "../whisper.js";
import { getState } from "../state.js";
import { fileMutationQueue } from "../../../lib/utils/file-mutation-queue.js";
import { braidDir, scratchpadDir } from "../../../lib/config/braid-paths.js";
import { projectSlugFromCwd } from "../../memory/scratchpad/persistence.js";
import { flushPendingScratchpadWrites } from "../../memory/scratchpad/utils.js";
import { isCompactionActive, getCmState } from "../../memory/context-manager/handlers/shared.js";
import { snapBoundaryOutsideToolBatch } from "../../memory/context-manager/handlers/tool-batch-boundary.js";
import {
  USAGE_COMPACT_AGGRESSIVE,
  USAGE_FIRED_RESET_BELOW,
  HYGIENE_AUTO_COMPACT_MIN_TURNS,
} from "../../../lib/detection/context-thresholds.js";
import { contextUsageNudgeMessage } from "../../../lib/detection/context-tiers.js";
import {
  measureLiveUsage,
  tokenArms,
  formatTokensK,
} from "../../../lib/detection/context-usage.js";
import {
  recordCompaction,
  recordHygieneAct,
  recordHygieneSkip,
  recordLiveUsageSample,
  type HygieneActTrigger,
  type HygieneActKind,
} from "../substate/context-hygiene-state.js";

const log = createLogger("enforcement:turn-end-hygiene");

// Pre-save safety: flush scratchpad + write resume.json

function saveStateBeforeCompact(cwd: string, ctx: ExtensionContext): void {
  try {
    // 1. Flush file mutation queue + scratchpad debounced queue
    // Pre-compaction flush is best-effort: a failed flush loses only the
    // newest queued writes; blocking compaction would lose far more.
    fileMutationQueue.flushAll().catch(() => {});
    flushPendingScratchpadWrites().catch(() => {});
  } catch {
    // flush APIs themselves failed — compaction must still proceed
  }

  try {
    // 2. Write resume.json (same format as SESSION_SHUTDOWN handler)
    const slug = projectSlugFromCwd(cwd);
    let goal: string | null = null;
    let openPlans: Array<{ id: string; text: string }> = [];
    let recentDecisions: Array<{ id: string; text: string }> = [];
    // Prior state is a READ: the scratchpad root is resolved on every call, so
    // a pinned run reads the tree the scratchpad writer wrote to, and a
    // segment rename in the accessor moves this reader with the writer. A
    // refused root (no absolute braid home) or a corrupt section degrades to
    // no prior-state section instead of failing the resume write below.
    try {
      const scratchpadFile = path.join(scratchpadDir(), slug, "latest.json");
      if (existsSync(scratchpadFile)) {
        const content = readFileSync(scratchpadFile, "utf-8");
        const parsed = JSON.parse(content);
        goal = parsed.goal ?? null;
        openPlans = (Array.isArray(parsed.plans) ? parsed.plans : [])
          .filter((p: any) => !p.done)
          .slice(0, 10)
          .map((p: any) => ({ id: p.id ?? "", text: p.text ?? "" }));
        recentDecisions = (Array.isArray(parsed.decisions) ? parsed.decisions : [])
          .slice(-5)
          .map((d: any) => ({ id: d.id ?? "", text: d.text ?? d.content ?? "" }));
      }
    } catch (err) {
      log.debug(`scratchpad prior-state read failed: ${err}`);
    }

    let uncommittedFiles: string[] = [];
    try {
      // Scope to the project dir only. When ctx.cwd is missing, `cwd` is "" and
      // git would otherwise run in the daemon's process.cwd() and record an
      // unrelated project's dirty files.
      if (cwd && existsSync(cwd)) {
        const status = execSync("git status --porcelain", {
          cwd,
          encoding: "utf-8",
          timeout: 5000,
          stdio: ["pipe", "pipe", "pipe"],
        });
        uncommittedFiles = status
          .split("\n")
          .filter((l) => l.trim())
          .map((l) => l.slice(3));
      }
    } catch {
      // not a git repo
    }

    const state = getState(ctx);
    const resumption = {
      writtenAt: new Date().toISOString(),
      cwd,
      goal,
      openPlans,
      recentDecisions,
      uncommittedFiles,
      toolCallCount: state?.totalToolCalls ?? 0,
      verificationCount: state?.verificationsDone ?? 0,
      reason: "turn-end auto-compact pre-save",
    };

    const sessionsDir = path.join(braidDir(), "sessions", slug);
    if (!existsSync(sessionsDir)) {
      mkdirSync(sessionsDir, { recursive: true });
    }
    const resumeFile = path.join(sessionsDir, "resume.json");
    writeFileSync(resumeFile, JSON.stringify(resumption, null, 2), "utf-8");
  } catch {
    // resume.json is a convenience: next session_start rebuilds resumption
    // from live session state, so a failed write costs nothing durable.
  }
}

/**
 * Recent-entries window kept by the deterministic slide the ACT arms.
 * Matches the slide tool's default keep window in size class (the tool
 * defaults to 50; the ACT keeps 40 so each act reclaims a comparable span).
 */
const ACT_SLIDE_KEEP_ENTRIES = 40;

/** The customInstructions marker the slide tool's compaction path consumes. */
const SLIDE_MODE_MARKER = "SLIDE_MODE:true";

/**
 * Read compaction.enabled the way pi resolves it (global settings merged
 * with the project's .pi/settings.json), freshly per act decision -- never
 * cached at registration. Defaults to true on any read failure, mirroring
 * pi's own default (settings.compaction?.enabled ?? true): when the mode is
 * unknown, native compaction is assumed to own the loop and the act stands
 * down to nudge-only.
 */
function compactionEnabledPerCheck(ctx: ExtensionContext): boolean {
  try {
    const cwd = (ctx as { cwd?: string }).cwd || process.cwd();
    return SettingsManager.create(cwd, getAgentDir()).getCompactionEnabled();
  } catch {
    return true;
  }
}

function checkContextUsage(pi: ExtensionAPI, ctx: ExtensionContext, event: any): void {
  const state = getState(ctx);
  if (!state?.enforcementActive) return;

  const currentTurn =
    typeof (event as any)?.turnIndex === "number"
      ? (event as any).turnIndex
      : state.lastContextCheckTurn + 1;

  // The live working set measured from the session tree (compaction-aware).
  // turn_end carries no usage accessor (its `context` is a boundary preview,
  // not an ExtensionContext), so this is the only source; when it yields no
  // number the skip below records that rather than acting on a fabricated 0.
  let usagePercent = 0;
  let usageTokens = 0;
  let usageWindow: number | undefined;
  try {
    const live = measureLiveUsage(ctx);
    if (live) {
      usagePercent = live.percent;
      usageTokens = live.tokens;
      usageWindow = live.contextWindow;
    }
  } catch {
    /* live measurement unavailable - the skip below records it */
  }

  if (usagePercent <= 0 && usageTokens <= 0) {
    // No usable number from either source: record the skip. Never act on a
    // fabricated zero (a zero would read as "plenty of room").
    recordHygieneSkip(state);
    return;
  }
  // The previous usable turn's live sample (the soft tier's crossing
  // witness), captured before this turn's sample replaces it.
  const prevLiveTokens = state.liveUsageSamples[state.liveUsageSamples.length - 1];
  recordLiveUsageSample(state, usageTokens);

  // Re-arm the shared context-nudge latch when usage has dropped (e.g.,
  // after compaction). The bar is the named policy value, not a literal.
  // It governs the higher tiers only; the soft tier re-arms on its own arm
  // crossing, gated at the cascade below.
  if (state.contextNudgeSent && usagePercent < USAGE_FIRED_RESET_BELOW) {
    state.contextNudgeSent = false;
  }

  // Auto-compact arms (fractions of the resolved window W)
  // act (min(0.60W, 130k)) re-arms after HYGIENE_AUTO_COMPACT_MIN_TURNS turns; the
  // percent arm (90%) keeps the same spacing; backstop (0.90W) bounds
  // runaway growth and is subject to the same cooldown, so the act can
  // never run every turn.
  const turnSinceLastCompact = currentTurn - (state.lastCompactionTurn ?? -100);
  const arms = tokenArms(usageWindow);
  const atTokenReArm =
    usageTokens >= arms.act && turnSinceLastCompact >= HYGIENE_AUTO_COMPACT_MIN_TURNS;
  const atPercentThreshold =
    usagePercent >= USAGE_COMPACT_AGGRESSIVE &&
    turnSinceLastCompact >= HYGIENE_AUTO_COMPACT_MIN_TURNS;
  const atHardBackstop = usageTokens >= arms.backstop;

  if (atHardBackstop || atTokenReArm || atPercentThreshold) {
    // Invariant: never act while a compaction is in progress, and keep the
    // turn-based cooldown between acts.
    if (turnSinceLastCompact < HYGIENE_AUTO_COMPACT_MIN_TURNS || isCompactionActive(ctx)) {
      recordHygieneSkip(state);
      return;
    }
    // Loop-done gate: "toolUse" means the agent loop is live -- the next
    // model call is queued inside the running agent operation, and
    // ctx.compact() aborts it (manual compaction never retries or continues
    // the interrupted turn). Act only on a loop-done stop; the 0.90W
    // backstop below still acts mid-loop to stop a runaway loop before
    // overflow (its purpose).
    const loopDone = (event as any)?.message?.stopReason !== "toolUse";
    if (!loopDone && !atHardBackstop) {
      recordHygieneSkip(state);
      return;
    }
    // Path resolution BEFORE the mode gate: the deterministic slide is not
    // LLM compaction and carries none of the abort/corruption risk that
    // justifies the nudge-only downgrade, so it fires regardless of
    // compaction.enabled. Only the summarize path is mode-gated: with pi's
    // compaction.enabled (re-read per act decision) native compaction owns
    // the loop and the act stands down to nudge-only.
    const plan = resolveHygieneActPlan(ctx);
    const compactionEnabled = compactionEnabledPerCheck(ctx);
    if (compactionEnabled && plan.kind !== "slide") {
      log.debug(
        `turn-end-hygiene: act arm reached (${Math.round(usagePercent)}%, ` +
          `${formatTokensK(usageTokens)}) but pi compaction.enabled=true and the act ` +
          `path is LLM summarize -- native compaction owns the loop; nudging only`,
      );
    } else {
      const trigger: HygieneActTrigger = atHardBackstop
        ? "backstop"
        : atTokenReArm
          ? "token"
          : "percent";
      state.contextNudgeSent = true;

      // Pre-save safety net before compaction
      saveStateBeforeCompact((ctx as { cwd?: string }).cwd ?? "", ctx);

      const kind = armHygieneAct(ctx, trigger, plan);
      if (!kind) {
        // The deterministic state could not be armed: stand down instead of
        // compacting on an unintended path. The next turn re-evaluates.
        log.debug("turn-end-hygiene: slide arming failed -- act stood down this turn");
        return;
      }
      recordCompaction(state, currentTurn);
      state.lastCompactionTurn = currentTurn;

      // Status notice for an action already taken: park (no forced turn).
      sendEnforcementWhisper(
        pi,
        ctx,
        `Auto-compacting: context at ${Math.round(usagePercent)}% ` +
          `(${formatTokensK(usageTokens)} tokens). State saved.`,
        false,
        { delivery: "park" },
      );
      return;
    }
  }

  if (state.contextNudgeSent) return;

  // Progressive nudge: token tiers first, then percent tiers. Cascade shared
  // from lib/detection/context-tiers.ts (contextUsageNudgeMessage):
  // token arms 0.45W/0.18W fire earlier for large windows, then percent tiers
  // soft (30%) -> advisory (50%) -> warning (65%) -> critical (75%) ->
  // compact (80%).
  const nudgeMessage = contextUsageNudgeMessage(usagePercent, usageTokens, usageWindow);
  if (nudgeMessage) {
    // Soft-tier crossing gate: the cascade's sub-warning level is the soft
    // token text (the percent tiers are shadowed by the token arms, which
    // fire first). It fires on the turn its arm is crossed from below, not
    // on every turn inside the band. The shared latch above re-arms below
    // USAGE_FIRED_RESET_BELOW, a bar above the soft arm, so without this
    // gate the same whisper re-injected every turn from the soft arm up to
    // the reset bar. The higher tiers keep the shared latch untouched.
    if (usageTokens < arms.warning) {
      const crossedSoftArm = prevLiveTokens === undefined || prevLiveTokens < arms.soft;
      if (!crossedSoftArm) return;
    }
    state.contextNudgeSent = true;
    sendEnforcementWhisper(pi, ctx, nudgeMessage);
  }
}

/**
 * The act's decided path from ONE branch snapshot: decide and arm from the
 * same read so the branch cannot change between the two.
 */
interface HygieneActPlan {
  kind: HygieneActKind;
  /** Entries before the slide cut (0 on the summarize path). */
  droppedEntries: number;
  /** Branch id of the first kept entry (slide path only). */
  cutEntryId?: string;
}

/**
 * Resolve the act path from the live branch: the deterministic slide when
 * the droppable range holds no owner/user turns (a silent cut would lose
 * the conversation), otherwise the LLM summarize path.
 */
function resolveHygieneActPlan(ctx: ExtensionContext): HygieneActPlan {
  try {
    const branch =
      (
        ctx as {
          sessionManager?: {
            getBranch?: () => Array<{ id: string; type?: string; message?: { role?: string } }>;
          };
        }
      ).sessionManager?.getBranch?.() ?? [];
    // The act arms a supplied compaction boundary: snap it out of any tool
    // batch it lands in (HTTP 400: a kept slice that opens with a tool result
    // has no preceding tool_calls).
    const cutIndex = snapBoundaryOutsideToolBatch(
      branch,
      Math.max(0, branch.length - ACT_SLIDE_KEEP_ENTRIES),
    );
    const droppable = branch.slice(0, cutIndex);
    const holdsUserTurns = droppable.some(
      (e) => e?.type === "message" && e.message?.role === "user",
    );
    if (cutIndex > 0 && !holdsUserTurns) {
      return { kind: "slide", droppedEntries: cutIndex, cutEntryId: branch[cutIndex]?.id };
    }
    return { kind: "summarize", droppedEntries: cutIndex };
  } catch {
    // Tree unavailable: summarize path without a dropped-count.
    return { kind: "summarize", droppedEntries: 0 };
  }
}

/**
 * Arm and schedule the decided act path. The act NEVER submits, injects or
 * re-arms a prompt or turn: ctx.compact() runs after the handler returns and
 * pi resumes through its own compaction flow.
 *
 * The slide path arms the slide state in the context-manager store the
 * session_before_compact handler consumes (the SLIDE_MODE marker branch);
 * that arming is the contract, so a failed arming stands the act down (the
 * caller skips compact + whisper) instead of silently switching to the LLM
 * path the mode gate may have just rejected. Returns the act kind, or null
 * when the act stood down.
 */
function armHygieneAct(
  ctx: ExtensionContext,
  trigger: HygieneActTrigger,
  plan: HygieneActPlan,
): HygieneActKind | null {
  if (plan.kind === "slide") {
    if (!plan.cutEntryId) return null;
    try {
      getCmState(ctx).slideMode = {
        active: true,
        cutEntryId: plan.cutEntryId,
        keepCount: ACT_SLIDE_KEEP_ENTRIES,
        droppedCount: plan.droppedEntries,
        timestamp: Date.now(),
      };
    } catch {
      return null;
    }
  }

  recordHygieneAct(getState(ctx), trigger, plan.kind, plan.droppedEntries);

  // Defer ctx.compact() to after the handler returns (register-session-compact
  // owns what happens after the compaction). customInstructions carries
  // SLIDE_MODE for the slide path; the summarize path keeps the pre-existing
  // keep-recent note.
  const instructions =
    plan.kind === "slide" ? SLIDE_MODE_MARKER : "Keep the most recent 10 messages.";
  setTimeout(() => {
    try {
      ctx.compact({ customInstructions: instructions });
    } catch {
      // agent already disconnected -- non-fatal
    }
  }, 0);
  return plan.kind;
}

export function registerTurnEndHygiene(pi: ExtensionAPI): void {
  registerTurnEndHandler("turn-end-hygiene", 5, async (event, ctx) => {
    try {
      checkContextUsage(pi, ctx, event);
    } catch (err) {
      log.error("turn-end-hygiene error:", err);
    }
  });

  log.debug(
    "turn-end-hygiene registered (priority 5) -- loop-done gate (no act on toolUse " +
      "stops); act at min(0.60W, 130k) tokens (or >=90%) after " +
      `${HYGIENE_AUTO_COMPACT_MIN_TURNS} turns; hard backstop 0.90W acts mid-loop; ` +
      "deterministic slide fires regardless of pi compaction.enabled; summarize " +
      "path is nudge-only when native compaction owns the loop",
  );
}
