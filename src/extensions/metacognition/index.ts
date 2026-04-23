/**
 * Metacognition Extension — structured thinking, debugging, finalization
 *
 * Replaces ad-hoc reasoning with structured protocols.
 * Uses the session's default model (ctx.model) for all LLM calls —
 * no separate utility model. Research shows the overhead of maintaining
 * a separate cheap model outweighs any marginal cost savings.
 *
 * Implements paper 2604.14731: Structured Cognitive Protocols
 */

import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { registerThink } from "./handlers/think.js";
import { registerHypothesize } from "./handlers/hypothesize.js";
import { registerFinalize } from "./handlers/finalize.js";

export default function register(pi: unknown) {
	registerThink(pi as ExtensionContext);
	registerHypothesize(pi as ExtensionContext);
	registerFinalize(pi as ExtensionContext);
}
