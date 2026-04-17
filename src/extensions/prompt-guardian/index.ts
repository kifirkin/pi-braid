/**
 * Prompt Guardian - Never lose a half-written prompt
 *
 * Automatically saves the current prompt buffer before submission.
 * Auto-save runs via event handlers - no tools exposed to LLM.
 *
 * Storage: ~/.pi/prompt-guardian/
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const GUARDIAN_DIR = path.join(os.homedir(), ".pi", "prompt-guardian");
const MAX_PROMPTS = 50;

interface SavedPrompt {
	id: string;
	text: string;
	timestamp: number;
	deleted: boolean;
}

function ensureGuardianDir(): void {
	if (!fs.existsSync(GUARDIAN_DIR)) {
		fs.mkdirSync(GUARDIAN_DIR, { recursive: true });
	}
}

function getPromptsFile(): string {
	return path.join(GUARDIAN_DIR, "prompts.json");
}

function loadPrompts(): SavedPrompt[] {
	ensureGuardianDir();
	const file = getPromptsFile();
	if (!fs.existsSync(file)) {
		return [];
	}
	try {
		return JSON.parse(fs.readFileSync(file, "utf-8")) as SavedPrompt[];
	} catch {
		return [];
	}
}

function savePrompts(prompts: SavedPrompt[]): void {
	ensureGuardianDir();
	fs.writeFileSync(getPromptsFile(), JSON.stringify(prompts, null, 2));
}

function generateId(): string {
	return Date.now().toString(36) + Math.random().toString(36).substring(2, 7);
}

export default function promptGuardianExtension(pi: ExtensionAPI) {
	let lastSavedText = "";

	// Save a prompt
	function savePrompt(text: string, deleted = false): void {
		if (!text.trim()) return;
		if (text === lastSavedText) return;

		lastSavedText = text;
		const prompts = loadPrompts();

		// Mark previous current as deleted
		for (const p of prompts) {
			if (!p.deleted) {
				p.deleted = true;
			}
		}

		// Add new prompt
		prompts.unshift({
			id: generateId(),
			text,
			timestamp: Date.now(),
			deleted,
		});

		// Keep only last MAX_PROMPTS
		if (prompts.length > MAX_PROMPTS) {
			prompts.splice(MAX_PROMPTS);
		}

		savePrompts(prompts);
	}

	// Session start - load last saved prompt
	pi.on("session_start", async (_event, _ctx) => {
		const prompts = loadPrompts();
		if (prompts.length > 0 && !prompts[0].deleted) {
			lastSavedText = prompts[0].text;
		}
	});

	// Before agent start - save current prompt before submission
	pi.on("before_agent_start", async (event) => {
		if (event.prompt?.trim()) {
			savePrompt(event.prompt, false);
		}
	});

	// Session shutdown - no-op (prompts are already persisted)
	pi.on("session_shutdown", async () => {});
}
