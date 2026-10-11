/**
 * turn-complete notify — key-ring-backed crafting model call.
 *
 * The notify model call reuses "our systems" — NOT the telegram bot token.
 * It resolves a model + API key through the pi extension context's
 * modelRegistry, which pi-braid-providers wires to the key-ring
 * (ring-lifecycle.ts auth.apiKey.resolve → getActiveKey()). This mirrors the
 * extension→LLM path used by core's llm-call.ts: completeSimple from
 * @earendil-works/pi-ai/compat, with the key coming from the provider, never
 * from telegram credentials.
 *
 * Model selection policy:
 *   1. BRAID_TG_NOTIFY_MODEL override (env, "provider/model-id" or "model-id")
 *   2. ctx.model (the session model)
 *   3. first available model in the registry
 */

import type { Context, Message, Model, Api } from "@earendil-works/pi-ai";
import { completeSimple } from "@earendil-works/pi-ai/compat";
import {
  buildNotifyPrompts,
  buildRichSummaryPrompts,
  type NotifyFormat,
} from "./craft.js";

/** Minimal registry surface used here (subset of pi-core ModelRegistry). */
export interface NotifyModelRegistry {
  find?(provider: string, modelId: string): Model<Api> | undefined;
  getAll?(): Model<Api>[];
  getAvailable?(): Model<Api>[];
  getApiKeyForProvider?(provider: string): Promise<string | undefined>;
  hasConfiguredAuth?(model: Model<Api>): boolean;
}

/**
 * Resolve the notify model. `configuredPattern` is an optional env override
 * shaped like "provider/model-id" (or bare "model-id"); falls back to the
 * session model, then the first available registry model.
 */
export function resolveNotifyModel(
  registry: NotifyModelRegistry,
  sessionModel: Model<Api> | undefined,
  configuredPattern?: string,
): Model<Api> | undefined {
  if (configuredPattern?.trim()) {
    const pattern = configuredPattern.trim();
    const slash = pattern.indexOf("/");
    if (slash >= 0) {
      const provider = pattern.slice(0, slash);
      const modelId = pattern.slice(slash + 1);
      const found = registry.find?.(provider, modelId);
      if (found) return found;
    } else {
      const all = registry.getAll?.() ?? [];
      const found = all.find(
        (m) => m.id === pattern || m.id.endsWith(`/${pattern}`),
      );
      if (found) return found;
    }
  }
  if (sessionModel) return sessionModel;
  const available = registry.getAvailable?.() ?? registry.getAll?.() ?? [];
  return available[0];
}

/** Output budget of a bare craft call (legacy default — targets fit in it). */
export const DEFAULT_CRAFT_MAX_TOKENS = 200;

/**
 * Output-token budget for a craft target of `chars` characters. A cap the
 * model cannot reach ends in mid-sentence (a visibly compressed message),
 * so the budget scales with the target: ~2 chars/token, floored at 512 and
 * capped at 4096 tokens. The turn-notify path passes this for notifyMaxChars.
 */
export function craftMaxTokensFor(chars: number): number {
  return Math.min(4096, Math.max(512, Math.ceil(chars / 2)));
}

/** Payload returned by the crafting call. */
export interface CraftModelResult {
  ok: boolean;
  text?: string;
  error?: string;
}

/**
 * Make the crafting call. Returns the distilled text on success, or a
 * non-throwing { ok:false } on failure so the caller can fall back to the
 * truncation guard. Injectable completeSimple for deterministic tests.
 */
export async function callCraftModel(
  registry: NotifyModelRegistry,
  model: Model<Api>,
  prompts: { system: string; user: string },
  opts: {
    completeSimpleFn?: typeof completeSimple;
    signal?: AbortSignal;
    /** Output token budget (default DEFAULT_CRAFT_MAX_TOKENS = 200). */
    maxTokens?: number;
  } = {},
): Promise<CraftModelResult> {
  try {
    let apiKey: string | undefined;
    if (registry.getApiKeyForProvider) {
      apiKey = await registry.getApiKeyForProvider(model.provider);
    }
    const fn = opts.completeSimpleFn ?? completeSimple;
    const context: Context = {
      systemPrompt: prompts.system,
      messages: [
        {
          role: "user",
          content: prompts.user,
          timestamp: Date.now(),
        } satisfies Message,
      ],
    };
    const assistant = await fn(model as Model<Api>, context, {
      apiKey,
      maxTokens: opts.maxTokens ?? DEFAULT_CRAFT_MAX_TOKENS,
      temperature: 0.2,
      signal: opts.signal,
    });
    if (assistant.errorMessage) {
      return { ok: false, error: assistant.errorMessage };
    }
    const text = (assistant.content ?? [])
      .filter((c): c is { type: "text"; text: string } => c.type === "text")
      .map((c) => c.text)
      .join("\n")
      .trim();
    if (!text)
      return { ok: false, error: "empty response from crafting model" };
    return { ok: true, text };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Build the text-crafting hook used by telegram_send and /telegram send: given
 * a too-long message, distill it to a concise owner update (≤ the applicable
 * send cap). Returns `null` when no model is resolvable or the call fails —
 * the caller ERRORS rather than truncating silently. Key-ring-backed
 * (modelRegistry), never the bot token. `opt.prompts` swaps the prompt builder
 * (rich summaries vs concise distills).
 */
export function createTextCraftHook(
  registry: NotifyModelRegistry,
  sessionModel: Model<Api> | undefined,
  configuredPattern?: string,
  opts: {
    completeSimpleFn?: typeof completeSimple;
    signal?: AbortSignal;
    prompts?: (text: string) => { system: string; user: string };
  } = {},
): (text: string) => Promise<{ text: string; crafted: boolean } | null> {
  const promptsBuilder = opts.prompts ?? buildNotifyPrompts;
  return async (
    text: string,
  ): Promise<{ text: string; crafted: boolean } | null> => {
    const model = resolveNotifyModel(registry, sessionModel, configuredPattern);
    if (!model) return null;
    const prompts = promptsBuilder(text);
    const result = await callCraftModel(registry, model, prompts, opts);
    if (!result.ok || !result.text) return null;
    return { text: result.text, crafted: true };
  };
}

/**
 * Rich-summary crafting hook for the live-update final report: same
 * key-ring-backed path as `createTextCraftHook`, but the prompt builder is the
 * rich variant (buildRichSummaryPrompts) — the report may be long and
 * formatted; split-to-fit handles the Telegram 4096 cap downstream. `opts.mode`
 * selects which markup the prompt asks for (default Markdown); the delivery
 * layer still re-guards the crafted body.
 */
export function createRichCraftHook(
  registry: NotifyModelRegistry,
  sessionModel: Model<Api> | undefined,
  configuredPattern?: string,
  opts: {
    completeSimpleFn?: typeof completeSimple;
    signal?: AbortSignal;
    mode?: NotifyFormat;
  } = {},
): (text: string) => Promise<{ text: string; crafted: boolean } | null> {
  return createTextCraftHook(registry, sessionModel, configuredPattern, {
    ...opts,
    prompts: (text: string) =>
      buildRichSummaryPrompts(text, opts.mode ?? "Markdown"),
  });
}
