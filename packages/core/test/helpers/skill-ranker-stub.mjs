/**
 * Answer the skills ranker from a fixture instead of a provider.
 *
 * The whisper's relevance judgement is a utility-model call, so a fixture that
 * expects a suggestion has to answer it. This installs the production path and
 * stubs only the transport (llm-call's own test seam), which means the prompt
 * build, the strict parse, the per-session cache and the ranker's counters all
 * run for real: what the fixture supplies is one model's answer, not the code
 * under test.
 *
 * Lives outside `test/runtime` on purpose: the suite walks that tree and counts
 * every module in it as a fixture, and a shared stub asserts nothing.
 */

import { join } from "node:path";

/** The model the fake registry serves: text in, text out, no cost. */
const STUB_MODEL = {
  id: "ranker-stub",
  provider: "stub",
  api: "stub-api",
  input: ["text"],
  contextWindow: 200_000,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

/** A model registry double: one model, one key, nothing available. */
export function rankerRegistry() {
  return {
    find: (provider, id) =>
      provider === STUB_MODEL.provider && id === STUB_MODEL.id ? STUB_MODEL : undefined,
    getAll: () => [STUB_MODEL],
    getAvailable: () => [STUB_MODEL],
    getApiKeyForProvider: async () => "stub-key",
  };
}

/** One assistant message in the shape the transport returns. */
function assistantMessage(fields) {
  return {
    role: "assistant",
    content: fields.text ? [{ type: "text", text: fields.text }] : [],
    api: "stub-api",
    provider: "stub",
    model: STUB_MODEL.id,
    usage: { input: 0, output: 0, totalTokens: 0 },
    stopReason: fields.stopReason ?? "stop",
    ...(fields.errorMessage ? { errorMessage: fields.errorMessage } : {}),
    timestamp: Date.now(),
  };
}

/** The user message text of one transport call. */
function userText(context) {
  return context.messages
    .map((message) => (typeof message.content === "string" ? message.content : ""))
    .join("\n");
}

/**
 * Install the stub. `handler(prompt, callIndex)` returns one of:
 *   - an array of `{name, why}` — serialized as the model's answer;
 *   - a string — the raw answer text, for a malformed-answer leg;
 *   - `{ error }` — a transport error.
 *
 * Returns the calls made (`{ prompt, systemPrompt }` per call) and a restore.
 */
export async function installRanker(distRoot, handler) {
  const { __setCompleteSimpleForTest } = await import(
    join(distRoot, "lib", "ai", "llm-call.js")
  );
  const { setCustomModelKey, UTILITY_MODEL_KEY } = await import(
    join(distRoot, "lib", "state", "global-state.js")
  );
  setCustomModelKey(UTILITY_MODEL_KEY, `${STUB_MODEL.provider}/${STUB_MODEL.id}`);
  const calls = [];
  __setCompleteSimpleForTest(async (_model, context) => {
    const prompt = userText(context);
    calls.push({ prompt, systemPrompt: context.systemPrompt ?? "" });
    const reply = handler(prompt, calls.length);
    if (reply && typeof reply === "object" && !Array.isArray(reply) && "error" in reply) {
      return assistantMessage({ errorMessage: reply.error, stopReason: "error" });
    }
    const text = typeof reply === "string" ? reply : JSON.stringify(reply ?? []);
    return assistantMessage({ text });
  });
  return { calls, restore: () => __setCompleteSimpleForTest(null) };
}

/** Take the utility model away, so the ranker has nothing to call. */
export async function removeUtilityModel(distRoot) {
  const { setCustomModelKey, UTILITY_MODEL_KEY } = await import(
    join(distRoot, "lib", "state", "global-state.js")
  );
  setCustomModelKey(UTILITY_MODEL_KEY, "");
}
