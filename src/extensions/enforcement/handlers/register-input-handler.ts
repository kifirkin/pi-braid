/**
 * register-input-handler — Language detection on user input.
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { detectLanguage, setLanguage } from "../../../lib/language-hint.js";
import { updateProblemContext } from "../../../lib/bidirectional-verifier.js";
import { getState } from "../state.js";
import { createLogger } from "../../../lib/core/logger.js";

const log = createLogger("enforcement:input");

export function registerInputHandler(pi: ExtensionAPI): void {
  pi.on("input", async (event: { text?: string; source?: string }, ctx: ExtensionContext) => {
    if (!getState(ctx).enforcementActive) return;
    const text = event.text || "";
    if (!text || text.startsWith("/") || event.source === "extension") return;

    const lang = detectLanguage(text);
    if (lang.code === "EN") return;

    setLanguage(ctx, lang.code, lang.name);
    getState(ctx).lastUserMessage = text;
    updateProblemContext(ctx, text);
  });
}
