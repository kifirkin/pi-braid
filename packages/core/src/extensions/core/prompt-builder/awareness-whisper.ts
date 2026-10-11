/**
 * Persistent Hygiene Whisper.
 *
 * Once-per-session context-hygiene whisper: tokens currently in context
 * plus tokens added since the previous emission's baseline. Cadence,
 * best-effort non-blocking delivery, flood-safety, and the pointer line.
 * CustomType is "hygiene".
 *
 * Delivery model: WHISPER. Steer, no trigger turn, display:true - the agent
 * sees it in the next turn and it is visible in the TUI; it does NOT live in
 * the system prompt. Best-effort: failure is logged at debug level and
 * swallowed, so it can never block the other once-per-session deliveries.
 *
 * "Since last baseline" data source: a cleanup/compaction marker lives in
 * context-manager (memory extension) state, which is NOT reachable from
 * prompt-builder without cross-extension plumbing. By design,
 * the baseline is therefore tracked inside this module: the first emission
 * sets the baseline, later session emissions report the delta. Storage is a
 * globalThis slot - the documented process-global pattern (see
 * lib/state/global-state.ts) - because getExtensionState is per-session and
 * would reset the baseline exactly when the cross-session delta needs it, and
 * module-level `let` state is banned by the project contract.
 *
 * Whisper-audit rule: no inline bracket sub-tags in the content. The
 * `[braid-whisper - <subsystem>]` envelope is added centrally by
 * sendTrackedMessage from the source tag - content starts with plain
 * readable text.
 */

import { createLogger } from "../../../lib/core/logger.js";
import { sendTrackedMessage } from "../../../lib/utils/injection-tracker.js";
import { formatTokensK } from "../../../lib/detection/context-usage.js";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const log = createLogger("prompt-builder/hygiene");

/**
 * globalThis slot for the emission baseline (tokens at the last whisper).
 * globalThis survives /reload and session replacement within the process,
 * which per-session extension state does not - see the cross-bundle note in
 * lib/state/global-state.ts for why the slot pattern is used.
 */
const HYGIENE_BASELINE_KEY = "__braid_hygiene_whisper_baseline_tokens";

function readBaselineTokens(): number | null {
  const slot = globalThis as Record<string, unknown>;
  const v = slot[HYGIENE_BASELINE_KEY];
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function writeBaselineTokens(tokens: number): void {
  (globalThis as Record<string, unknown>)[HYGIENE_BASELINE_KEY] = tokens;
}

/** Counts gathered by the caller for the once-per-session hygiene whisper. */
export interface AwarenessCounts {
  /** Tokens currently in context at emission time (0 when usage is unavailable). */
  tokensInContext: number;
  /** Registered context_* tools - guards the pointer line (tool availability). */
  contextToolCount: number;
  /**
   * TG inbound channel liveness at build time, from the poller liveness
   * registry (lib/state/telegram-poller-liveness.ts). "live" renders today's
   * row; "off" and "unknown" render a hedged variant that names the check,
   * so the catalog never asserts reachability the live state cannot back.
   */
  telegramInbound: TelegramInboundState;
}

/** Liveness of the TG inbound channel as known at whisper build time. */
export type TelegramInboundState = "live" | "off" | "unknown";

/** AwarenessCounts plus the since-baseline delta computed at delivery time. */
export interface HygieneSignal extends AwarenessCounts {
  /**
   * Tokens added since the previous emission's baseline. null when this
   * emission is the first one (it sets the baseline; delta comes later).
   */
  tokensSinceBaseline: number | null;
}

/**
 * Render the hygiene text: one summary line + one pointer line + the
 * agent-facing reachability catalog ("which braid systems can reach you").
 * Plain text, no bracket sub-tags. Catalog invariant: the envelope format
 * is stable, the subsystem list is not - subsystem whispers are described
 * by their envelope rather than enumerated, because a fixed enumeration
 * drifts as subsystems come and go; the example set names subsystems that
 * actually produce whispers in this repo. The whole catalog stays ≤80
 * tokens. Pure - no pi/ctx dependency; the TG row's state rides in on the
 * input signal.
 */
export function formatAwarenessText(signal: HygieneSignal): string {
  const now = Math.max(0, Math.round(signal.tokensInContext / 1024));
  const delta =
    signal.tokensSinceBaseline === null
      ? `baseline set (${now}K) - delta reported on a later session`
      : `+${formatTokensK(Math.max(0, signal.tokensSinceBaseline))} since last baseline`;
  const inspector =
    signal.contextToolCount > 0
      ? "Inspect with system_info, memory recall, or context_inspect."
      : "Inspect with system_info or memory recall on demand.";
  // The TG row asserts reachability only when the live poller state
  // backs it. "off" is known-not-live (poller stopped); "unknown" means no
  // probe was published (telegram absent or silent). Both hedge and name the
  // check instead of asserting "on arrival". Each variant names the reply
  // tool so an enveloped owner message is answered on the channel it came in.
  const tgRow =
    signal.telegramInbound === "live"
      ? "- TG inbound: owner Telegram messages, on arrival — reply via telegram_send"
      : signal.telegramInbound === "off"
        ? "- TG inbound: owner Telegram messages, poller not running (telegram_poller status) — reply via telegram_send"
        : "- TG inbound: owner Telegram messages, reachability unverified (telegram_poller status) — reply via telegram_send";
  // Subsystem rows describe the stable mechanism, not a fixed list: every
  // sendTrackedMessage delivery is enveloped by lib/utils/whisper-format.ts,
  // so any current or future subsystem reaches the agent the same way. The
  // examples name real producers (first segments of source tags in this
  // repo); no cadences are claimed. The envelope template is a literal here
  // because whisper-format.ts exports no template constant to import (a
  // call would render a live timestamp); the format's owner is named so the
  // two sites are discoverable together.
  const catalog = [
    "Can reach you (injection channels):",
    "- subsystem whispers arrive in [braid-whisper - <subsystem> @ <time>] envelopes — the tag names the sending subsystem (e.g. enforcement, heartbeat, watchdog, timer, context-lifecycle)",
    tgRow,
    "- owner TUI input: a message with no [braid-whisper ...] envelope — answer in-session",
  ].join("\n");
  return `Hygiene: ${now}K tokens in context; ${delta}.\n${inspector}\n${catalog}`;
}

/**
 * Deliver the hygiene whisper (best-effort, non-blocking).
 * Steer message with triggerTurn:false; any failure is logged at debug
 * level and swallowed so the whisper never blocks other deliveries.
 * Emission order matters: read the previous baseline BEFORE overwriting it,
 * so the delta reflects the previous emission, not this one.
 */
export async function deliverAwarenessWhisper(
  pi: ExtensionAPI,
  _ctx: ExtensionContext,
  counts: AwarenessCounts,
): Promise<void> {
  try {
    const baseline = readBaselineTokens();
    const tokensSinceBaseline =
      baseline === null ? null : Math.max(0, counts.tokensInContext - baseline);
    writeBaselineTokens(counts.tokensInContext);
    const signal: HygieneSignal = { ...counts, tokensSinceBaseline };
    sendTrackedMessage(
      pi,
      {
        customType: "hygiene",
        display: true,
        content: [{ type: "text" as const, text: formatAwarenessText(signal) }],
      },
      { delivery: "park", deliverAs: "steer" },
      { type: "context", source: "prompt-builder/hygiene" },
    );
  } catch (err) {
    log.debug(`hygiene whisper delivery failed (non-fatal): ${String(err)}`);
  }
}
