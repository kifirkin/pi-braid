/**
 * register-input-handler - Language detection on user input.
 *
 * Stores the detected language on the session (setLanguage) for a
 * reply-language instruction that nothing renders yet: getReplyInstruction in
 * lib/ai/language-hint.ts has no caller.
 */

import { INPUT } from "../../../lib/core/event-names.js";
import type { ExtensionAPI, ExtensionContext, InputEvent } from "@earendil-works/pi-coding-agent";
import { detectLanguage, setLanguage } from "../../../lib/ai/language-hint.js";
import { updateProblemContext } from "../../../lib/store/bidirectional-verifier.js";
import { getState } from "../state.js";

export function registerInputHandler(pi: ExtensionAPI): void {
  pi.on(INPUT, async (event: InputEvent, ctx: ExtensionContext) => {
    if (!getState(ctx).enforcementActive) return;
    const text = event.text || "";
    if (!text || text.startsWith("/") || event.source === "extension") return;

    // Skip language detection for mid-stream steers and queued follow-ups -
    // these aren't new user messages, so they shouldn't update language hints
    // or problem context.
    if (event.streamingBehavior) return;

    const lang = detectLanguage(text);
    if (lang.code === "EN") return;

    setLanguage(ctx, lang.code, lang.name);
    getState(ctx).lastUserMessage = text;
    if (!getState(ctx).originalRequest) {
      getState(ctx).originalRequest = text;
    }
    updateProblemContext(ctx, text);
  });
}
