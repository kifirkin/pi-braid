/**
 * turn-complete auto-notify — turn_end handler orchestration.
 *
 * On turn_end with a completed plain-text answer (no trailing tool call):
 *   1. rate-limit gate (max N per minute, sliding window)
 *   2. distilling LLM call (via the injected model loader — key-ring-backed)
 *   3. guard-fallback to the notifyMaxChars cap (crafting model produces the
 *      message; the truncation rule stays only as a safety net)
 *   4. deliver through the outbound seam (telegram client — no [tg-end])
 *
 * The handler is pure-of-network: the model call and delivery are injected so
 * the fixture tests run deterministically with zero real LLM calls and zero
 * network. Production wiring (src/index.ts) supplies the real implementations.
 */

import {
  shouldNotifyTurnEnd,
  extractFinalText,
  buildNotifyPrompts,
  truncateGuard,
} from "./craft.js";
import { SlidingWindowLimiter } from "./rate-limit.js";
import {
  craftMaxTokensFor,
  type CraftModelResult,
  type NotifyModelRegistry,
} from "./model.js";
import { resolveNotifyMaxChars } from "../telegram-settings.js";
import type { Model, Api } from "@earendil-works/pi-ai";

/** Model-call context bound from the turn_end ExtensionContext. */
export interface NotifyModelCtx {
  registry: NotifyModelRegistry;
  sessionModel?: Model<Api> | undefined;
}

export interface TurnNotifyDeps {
  /** Distilling model call. The model + key are resolved from `modelCtx`
   *  inside the handler (key-ring-backed via ctx.modelRegistry). `opts.maxTokens`
   *  is the output budget sized for the resolved notify cap — forward it to the
   *  provider so a long target is not cut mid-sentence.
   */
  callModel(
    prompts: { system: string; user: string },
    modelCtx: NotifyModelCtx,
    opts?: { maxTokens?: number },
  ): Promise<CraftModelResult>;
  /** Outbound delivery of the crafted text (≤ notifyMaxChars). Never [tg-end]-decorated. */
  deliver(text: string): Promise<void> | void;
  /** Clock (injectable for deterministic rate-limit tests). */
  now?(): number;
  /** Max auto-notifies per window. */
  maxPerWindow?: number;
  /** Sliding window length in ms. */
  windowMs?: number;
  /** Guard-fallback length cap override (default: braid.telegram.notifyMaxChars). */
  maxLength?: number;
}

/** Shared defaults — policy surface for the design decision list. */
export const DEFAULT_NOTIFY_MAX_PER_MIN = 4;
export const DEFAULT_NOTIFY_WINDOW_MS = 60_000;

export interface TurnNotifyOutcome {
  notified: boolean;
  /** Why nothing was sent (rate-limited / no text / model+guard both empty). */
  skipped?: "rate-limited" | "no-answer-text" | "empty-result";
  text?: string;
}

/**
 * Build the turn_end handler. Non-throwing: any failure inside is swallowed and
 * logged to the caller's sink — an auto-notify must never break the turn loop.
 */
export function createTurnNotifyHandler(
  deps: TurnNotifyDeps,
): (
  event: unknown,
  modelCtx: NotifyModelCtx,
  log?: (m: string, t?: "info" | "warning" | "error") => void,
) => Promise<TurnNotifyOutcome> {
  const limiter = new SlidingWindowLimiter({
    maxPerWindow: deps.maxPerWindow ?? DEFAULT_NOTIFY_MAX_PER_MIN,
    windowMs: deps.windowMs ?? DEFAULT_NOTIFY_WINDOW_MS,
  });
  const now = deps.now ?? (() => Date.now());

  /** Resolve the cap per call: explicit override, else settings (no caching). */
  const resolveCap = (): number =>
    typeof deps.maxLength === "number" &&
    Number.isFinite(deps.maxLength) &&
    deps.maxLength >= 1
      ? Math.floor(deps.maxLength)
      : resolveNotifyMaxChars();

  return async (
    event,
    modelCtx,
    log = () => {},
  ): Promise<TurnNotifyOutcome> => {
    try {
      if (!shouldNotifyTurnEnd(event)) return { notified: false };
      if (!limiter.try(now()))
        return { notified: false, skipped: "rate-limited" };

      const finalText = extractFinalText(event);
      if (!finalText) return { notified: false, skipped: "no-answer-text" };

      const cap = resolveCap();
      const prompts = buildNotifyPrompts(finalText, cap);
      const crafted = await deps.callModel(prompts, modelCtx, {
        maxTokens: craftMaxTokensFor(cap),
      });

      // Crafting model produces the message; guard-truncate is the fallback.
      const text = truncateGuard(
        crafted.ok && crafted.text ? crafted.text : finalText,
        cap,
      );
      if (!text) return { notified: false, skipped: "empty-result" };

      await deps.deliver(text);
      if (!crafted.ok) {
        log(
          `[telegram notify] crafting model failed (${crafted.error ?? "unknown"}) — delivered guard-truncated text`,
          "warning",
        );
      }
      return { notified: true, text };
    } catch (err) {
      log(
        `[telegram notify] error: ${err instanceof Error ? err.message : String(err)}`,
        "error",
      );
      return { notified: false };
    }
  };
}
