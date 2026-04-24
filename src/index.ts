/**
 * pi-braid - pi-coding-agent extension
 *
 * Planning, metacognition, cognitive systems, enforcement,
 * evolution, skills, and more...
 *
 * Usage:
 *   pi -e /path/to/pi-braid
 *   # Or install in settings.json:
 *   # { "extensions": ["/path/to/pi-braid"] }
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { createLogger } from "./lib/logger.js";

// ── Root Logger ──────────────────────────────────────────────────────────────
const _log = createLogger("pi-braid");

// ── Extension modules ───────────────────────────────────────────────────────
import polyfillExtension from "./extensions/polyfill/index.js";
import errorCaptureExtension from "./extensions/error-capture/index.js";
import promptBuilderExtension from "./extensions/prompt-builder/index.js";
import plannerExtension from "./extensions/planner/index.js";
import metacognitionExtension from "./extensions/metacognition/index.js";
import verificationExtension from "./extensions/verification/index.js";
import topicDriftExtension from "./extensions/topic-drift/index.js";
import scratchpadExtension from "./extensions/scratchpad/index.js";
import cognitiveSystemsExtension from "./extensions/cognitive-systems/index.js";
import contextManagerExtension from "./extensions/context-manager/index.js";
import contextLifecycleExtension from "./extensions/context-lifecycle/index.js";
import sessionRecallExtension from "./extensions/session-recall/index.js";
import docsExtension from "./extensions/docs/index.js";
import codebaseTreeExtension from "./extensions/codebase-tree/index.js";
import healthcheckExtension from "./extensions/healthcheck/index.js";
import promptGuardianExtension from "./extensions/prompt-guardian/index.js";
import evolveExtension from "./extensions/evolve/index.js";
import enforcementExtension from "./extensions/enforcement/index.js";
import userMessagePreprocessorExtension from "./extensions/user-message-preprocessor/index.js";
import uxExtension from "./extensions/ux/index.js";
import webFetchExtension from "./extensions/web-fetch/index.js";
import browserExtension from "./extensions/browser/index.js";
import assistantExtension from "./extensions/assistant/index.js";
import visionExtension from "./extensions/vision/index.js";
import replExtension from "./extensions/repl/index.js";
// import waitReviewExtension from "./extensions/wait-review/index.js";
import heartbeatSchedulerExtension from "./extensions/heartbeat-scheduler/index.js";
import threeMemoryStoresExtension from "./extensions/three-memory-stores/index.js";
import watchdogExtension from "./extensions/watchdog/index.js";
import rateLimiterExtension from "./extensions/rate-limiter/index.js";
import reasoningExtension from "./extensions/reasoning/index.js";
import latentActivatorExtension from "./extensions/latent-activator/index.js";
import analyticsExtension from "./extensions/analytics/index.js";
import feedbackExtension from "./extensions/feedback/index.js";

// ── Skills directory ────────────────────────────────────────────────────────
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
export const SKILLS_DIR = join(__dirname, "..", "skills");

// ── Sub-extensions in dependency order ────────────────────────────────────
const SUB_EXTENSIONS: Array<{ name: string; factory: (pi: ExtensionAPI) => void }> = [
	{ name: "polyfill", factory: polyfillExtension },
	{ name: "error-capture", factory: errorCaptureExtension },
	{ name: "prompt-builder", factory: promptBuilderExtension },
	{ name: "planner", factory: plannerExtension },
	{ name: "metacognition", factory: metacognitionExtension },
	{ name: "verification", factory: verificationExtension },
	{ name: "topic-drift", factory: topicDriftExtension },
	{ name: "scratchpad", factory: scratchpadExtension },
	{ name: "cognitive-systems", factory: cognitiveSystemsExtension },
	{ name: "context-manager", factory: contextManagerExtension },
	// context-lifecycle goes AFTER context-manager — reads session entries and enhances with proposals
	{ name: "context-lifecycle", factory: contextLifecycleExtension },
	{ name: "session-recall", factory: sessionRecallExtension },
	{ name: "docs", factory: docsExtension },
	{ name: "codebase-tree", factory: codebaseTreeExtension },
	{ name: "healthcheck", factory: healthcheckExtension },
	{ name: "prompt-guardian", factory: promptGuardianExtension },
	{ name: "evolve", factory: evolveExtension },
	{ name: "enforcement", factory: enforcementExtension },
	{ name: "user-message-preprocessor", factory: userMessagePreprocessorExtension },
	{ name: "ux", factory: uxExtension },
	{ name: "web-fetch", factory: webFetchExtension },
	{ name: "browser", factory: browserExtension },
	{ name: "assistant", factory: assistantExtension },
	{ name: "vision", factory: visionExtension },
  { name: "repl", factory: replExtension },
	// FIXME: marked deprecated
	// { name: "wait-review", factory: waitReviewExtension },
	{ name: "heartbeat-scheduler", factory: heartbeatSchedulerExtension },
	{ name: "three-memory-stores", factory: threeMemoryStoresExtension },
	{ name: "watchdog", factory: watchdogExtension },
	{ name: "rate-limiter", factory: rateLimiterExtension },
	{ name: "reasoning", factory: reasoningExtension },
	{ name: "latent-activator", factory: latentActivatorExtension },
	{ name: "analytics", factory: analyticsExtension },
	{ name: "feedback", factory: feedbackExtension },
];

// ── Main extension entry ───────────────────────────────────────────────────
export default function piBraidExtension(pi: ExtensionAPI) {
	// 1. Load all sub-extensions in dependency order
	for (const { name, factory } of SUB_EXTENSIONS) {
		try {
			factory(pi);
		} catch (err) {
			_log.error(`Failed to load sub-extension "${name}":`, err);
		}
	}

	// 2. Contribute bundled skills via resources_discover
	pi.on("resources_discover", async () => {
		return { skillPaths: [SKILLS_DIR] };
	});
}
