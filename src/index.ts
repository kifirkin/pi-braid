/**
 * pi-braid — Self-contained pi-coding-agent extension
 *
 * Bundles all develop-branch functionality into a single installable extension:
 * - Planning: tasks, goals, plans, execution control
 * - Metacognition: think, hypothesize, time tracking
 * - Cognitive systems: memory, knowledge integration
 * - Enforcement: tool usage validation, nudge/whisper system
 * - Feedback: smart nudge and whisper system
 * - Evolution: self-evolution commands
 * - Skills: 16 specialized skill modules
 * - And more...
 *
 * Usage:
 *   pi -e /path/to/pi-braid
 *   # Or install in settings.json:
 *   # { "extensions": ["/path/to/pi-braid"] }
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

// Extension modules
// NEW: polyfill must load FIRST — patches getUtilityModel/getVisionModel
import polyfillExtension from "./extensions/polyfill/index.js";
// NEW: error capture must load early to catch errors from other extensions
import errorCaptureExtension from "./extensions/error-capture/index.js";
// NEW: prompt builder replaces system prompt with develop-branch identity framing
import promptBuilderExtension from "./extensions/prompt-builder/index.js";

import codebaseTreeExtension from "./extensions/codebase-tree/index.js";
import cognitiveSystemsExtension from "./extensions/cognitive-systems/index.js";
import contextManagerExtension from "./extensions/context-manager/index.js";
import docsExtension from "./extensions/docs/index.js";
import enforcementExtension from "./extensions/enforcement/index.js";
import evolveExtension from "./extensions/evolve/index.js";
import feedbackExtension from "./extensions/feedback/index.js";
import fileToolExtension from "./extensions/file-tool.js";
import healthcheckExtension from "./extensions/healthcheck/index.js";
import metacognitionExtension from "./extensions/metacognition/index.js";
import pijulCheckpointExtension from "./extensions/pijul-checkpoint/index.js";
import plannerExtension from "./extensions/planner/index.js";
import promptGuardianExtension from "./extensions/prompt-guardian/index.js";
import rateLimiterExtension from "./extensions/rate-limiter/index.js";
import reasoningExtension from "./extensions/reasoning/index.js";
import replExtension from "./extensions/repl/index.js";
import scratchpadExtension from "./extensions/scratchpad/index.js";
import sessionRecallExtension from "./extensions/session-recall/index.js";
import analyticsExtension from "./extensions/analytics/index.js";
import userMessagePreprocessorExtension from "./extensions/user-message-preprocessor/index.js";
import visionExtension from "./extensions/vision/index.js";
import watchdogExtension from "./extensions/watchdog/index.js";

// Resolve the skills directory relative to this file
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const SKILLS_DIR = join(__dirname, "..", "skills");

/**
 * Ordered list of sub-extensions to load.
 *
 * Order matters: extensions that others depend on should come first.
 * - planner must load before others that use goals/tasks
 * - metacognition provides think/hypothesize tools used broadly
 * - enforcement and feedback are reactive — load later
 */
const SUB_EXTENSIONS: Array<{ name: string; factory: (pi: ExtensionAPI) => void }> = [
	// CRITICAL: polyfill loads first to patch context methods
	{ name: "polyfill", factory: polyfillExtension },
	// CRITICAL: error-capture loads early to catch errors from other extensions
	{ name: "error-capture", factory: errorCaptureExtension },
	// CRITICAL: prompt-builder replaces system prompt with identity framing
	{ name: "prompt-builder", factory: promptBuilderExtension },
	{ name: "planner", factory: plannerExtension },
	{ name: "metacognition", factory: metacognitionExtension },
	{ name: "scratchpad", factory: scratchpadExtension },
	{ name: "cognitive-systems", factory: cognitiveSystemsExtension },
	{ name: "context-manager", factory: contextManagerExtension },
	{ name: "session-recall", factory: sessionRecallExtension },
	{ name: "docs", factory: docsExtension },
	{ name: "pijul-checkpoint", factory: pijulCheckpointExtension },
	{ name: "codebase-tree", factory: codebaseTreeExtension },
	{ name: "healthcheck", factory: healthcheckExtension },
	{ name: "prompt-guardian", factory: promptGuardianExtension },
	{ name: "file-tool", factory: fileToolExtension },
	{ name: "evolve", factory: evolveExtension },
	{ name: "enforcement", factory: enforcementExtension },
	{ name: "feedback", factory: feedbackExtension },
	{ name: "analytics", factory: analyticsExtension },
	{ name: "user-message-preprocessor", factory: userMessagePreprocessorExtension },
	{ name: "watchdog", factory: watchdogExtension },
	{ name: "rate-limiter", factory: rateLimiterExtension },
	{ name: "vision", factory: visionExtension },
	{ name: "reasoning", factory: reasoningExtension },
	{ name: "repl", factory: replExtension },
];

export default function piBraidExtension(pi: ExtensionAPI) {
	// 1. Load all sub-extensions in dependency order
	for (const { name, factory } of SUB_EXTENSIONS) {
		try {
			factory(pi);
		} catch (err) {
			console.error(`[pi-braid] Failed to load sub-extension "${name}": ${err}`);
		}
	}

	// 2. Contribute bundled skills via resources_discover
	pi.on("resources_discover", async (_event, _ctx) => {
		return {
			skillPaths: [SKILLS_DIR],
		};
	});
}
