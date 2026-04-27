/**
 * Module loader — config-driven extension loading with runtime toggling.
 *
 * Config sources (priority: high → low):
 *   1. Runtime subagent API — /modules-toggle, /modules-enable, /modules-disable
 *   2. Pi's native settings — `braid.modules` property in ~/.pi/agent/settings.json
 *   3. Environment variable — BRAID_MODULES (+name to enable, -name to disable)
 *   4. Default — all non-disabled modules enabled
 *
 * Pi's settings.json is the canonical config file. A `braid` top-level key
 * stores all braid-specific configuration, mirroring how pi-native settings
 * like `compaction`, `retry`, and `terminal` are stored.
 *
 * Researcher subagent workflow:
 *   agent: /modules-list
 *   agent: /modules-disable cognitive   # runs benchmark without cognitive module
 *   agent: run benchmark
 *   agent: /modules-toggle cognitive     # re-enable for next session
 */

import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { createLogger } from "../lib/logger.js";
import { getExtensionState } from "../lib/extension-state.js";

import {
	type ModuleDef,
	type SubExtension,
	MODULE_DEFINITIONS,
	getModuleDef,
	getDefaultEnabledModules,
	getAllModuleNames,
} from "./definitions.js";

const log = createLogger("modules");

// ──── Pi's native settings paths ─────────────────────────────────────────────
// Settings follow pi's two-tier hierarchy:
//   1. Global:  ~/.pi/agent/settings.json  (shared across all projects)
//   2. Project: <cwd>/.pi/settings.json    (overrides global, preferred for toggles)
//
// The `braid` key is a top-level property in both files, merged with
// project-local taking priority — matching pi's native merge behaviour.

const GLOBAL_SETTINGS = join(homedir(), ".pi", "agent", "settings.json");

function getProjectSettingsPath(): string {
	try {
		// Derive CWD from the module path (best approximation at load time)
		const cwd = process.cwd();
		return join(cwd, ".pi", "settings.json");
	} catch {
		return "";
	}
}

/** The braid config key within settings.json */
const BRAID_KEY = "braid";

interface BraidSettings {
	modules?: Record<string, boolean>;
}

// ──── Runtime config store ───────────────────────────────────────────────────

interface ModuleLoaderState {
	runtimeConfig: Map<string, boolean>;
	loaded: string[];
	loadedCount: number;
	skipped: { module: string; ext: string; reason: string }[];
}

function getLoaderState(ctx?: ExtensionContext): ModuleLoaderState {
	if (!ctx) {
		if (!_globalLoaderState) _globalLoaderState = {
			runtimeConfig: new Map(),
			loaded: [],
			loadedCount: 0,
			skipped: [],
		};
		return _globalLoaderState;
	}
	return getExtensionState(ctx, "module-loader", () => ({
		runtimeConfig: new Map(),
		loaded: [],
		loadedCount: 0,
		skipped: [],
	}));
}

let _globalLoaderState: ModuleLoaderState | null = null;

// ──── Pi settings.json persistence (two-tier: global + project) ─────────────

/** Read a single settings file and return its contents (or {}). */
function readSettingsFile(path: string): Record<string, unknown> {
	try {
		return JSON.parse(readFileSync(path, "utf-8"));
	} catch {
		return {};
	}
}

/**
 * Read the merged `braid` property from pi's two-tier settings.
 * Project-local overrides global, matching pi's native merge behaviour.
 * Returns an empty object if neither file has a `braid` key.
 */
function readBraidSettings(): BraidSettings {
	const global_ = readSettingsFile(GLOBAL_SETTINGS);
	const projectPath = getProjectSettingsPath();
	const project_ = projectPath ? readSettingsFile(projectPath) : {};

	// Deep merge: project overrides global for `braid.modules`
	const globalModules = (global_[BRAID_KEY] as BraidSettings)?.modules ?? {};
	const projectModules = (project_[BRAID_KEY] as BraidSettings)?.modules ?? {};

	const merged: Record<string, boolean> = { ...globalModules };
	for (const [k, v] of Object.entries(projectModules)) {
		merged[k] = v;
	}

	return { modules: Object.keys(merged).length > 0 ? merged : undefined };
}

/**
 * Write the `braid` property into the **project-local** .pi/settings.json,
 * preserving all other existing settings.
 *
 * The project-level file is preferred because:
 *   - braid is a project-level concern (extension configuration)
 *   - pi's project settings override global settings
 *   - It facilitates project-specific benchmark configs
 */
function writeBraidSettings(braid: BraidSettings): void {
	const projectPath = getProjectSettingsPath();
	if (!projectPath) {
		log.warn("Cannot determine project path for settings write");
		return;
	}
	try {
		const all = readSettingsFile(projectPath);
		all[BRAID_KEY] = braid;
		writeFileSync(projectPath, JSON.stringify(all, null, 2), "utf-8");
	} catch (e) {
		log.warn(`Failed to write braid settings: ${(e as Error).message}`);
	}
}

/** Read module overrides from pi's merged settings (global + project). */
function readModuleOverridesFromSettings(): Record<string, boolean> {
	const braid = readBraidSettings();
	return braid.modules ?? {};
}

/** Write module overrides to pi's project-local settings.json. */
function saveModuleOverridesToFile(overrides: Map<string, boolean>): void {
	const modules: Record<string, boolean> = {};
	for (const [name, val] of overrides) {
		modules[name] = val;
	}
	writeBraidSettings({ modules });
}

// ──── Config resolution ──────────────────────────────────────────────────────

export interface ResolvedConfig {
	enabled: string[];
	source: "runtime-api" | "settings-json" | "env-var" | "defaults";
}

/** Resolve which modules are enabled, tracing the config source. */
export function resolveEnabledModules(envOverride?: string): ResolvedConfig {
	const state = getLoaderState();
	const env = envOverride ?? process.env.BRAID_MODULES ?? null;
	const defaults = getDefaultEnabledModules();

	// Priority 1: Runtime API overrides (set by subagent in current session)
	if (state.runtimeConfig.size > 0) {
		const enabled = defaults.filter((n) => {
			const override = state.runtimeConfig.get(n);
			return override !== undefined ? override : true;
		});
		return { enabled, source: "runtime-api" };
	}

	// Priority 2: Pi's native settings.json → braid.modules
	const settingsOverrides = readModuleOverridesFromSettings();
	if (Object.keys(settingsOverrides).length > 0) {
		const enabled = [...new Set([
			...defaults.filter((n) => {
				const val = settingsOverrides[n];
				return val !== undefined ? val : true;
			}),
			// Also enable any opt-in modules explicitly set to true
			...Object.entries(settingsOverrides)
				.filter(([k, v]) => v && !defaults.includes(k))
				.map(([k]) => k),
		])];
		return { enabled, source: "settings-json" };
	}

	// Priority 3: Environment variable
	if (env && env.trim()) {
		const parts = env.split(",").map((s) => s.trim()).filter(Boolean);
		const disabled = new Set<string>();
		const enabled = new Set<string>();
		const explicit: string[] = [];
		for (const part of parts) {
			if (part.startsWith("+")) { enabled.add(part.slice(1)); explicit.push(part.slice(1)); }
			else if (part.startsWith("-")) { disabled.add(part.slice(1)); }
			else { enabled.add(part); explicit.push(part); }
		}
		if (explicit.length > 0) return { enabled: explicit.filter((n) => !disabled.has(n)), source: "env-var" };
		return { enabled: defaults.filter((n) => !disabled.has(n)), source: "env-var" };
	}

	// Priority 4: Defaults
	return { enabled: defaults, source: "defaults" };
}

// ──── Loading ────────────────────────────────────────────────────────────────

export interface LoadReport {
	loaded: { module: string; extensions: number }[];
	skipped: { module: string; ext: string; reason: string }[];
	total: number;
	source: string;
}

/**
 * Load all enabled modules based on resolved config.
 * Calls each extension's factory with the pi API.
 */
export async function loadModules(pi: ExtensionAPI, envOverride?: string): Promise<LoadReport> {
	const state = getLoaderState();
	const { enabled, source } = resolveEnabledModules(envOverride);
	const loaded: LoadReport["loaded"] = [];
	const skipped: LoadReport["skipped"] = [];
	let total = 0;

	log.info(`Loading modules from config: ${source}`);
	log.info(`Enabled: ${enabled.join(", ")}`);

	const ordered = topologicalSort(enabled);

	for (const moduleName of ordered) {
		const def = getModuleDef(moduleName);
		if (!def) { skipped.push({ module: moduleName, ext: "", reason: "not found" }); continue; }

		const extList: { name: string }[] = [];
		for (const ext of def.extensions) {
			try {
				await ext.fn(pi);
				total++;
				extList.push(ext);
			} catch (err) {
				skipped.push({ module: moduleName, ext: ext.name, reason: (err as Error).message });
				log.error(`Failed to load ${moduleName}/${ext.name}: ${(err as Error).message}`);
			}
		}
		if (extList.length > 0) {
			loaded.push({ module: moduleName, extensions: extList.length });
		} else {
			skipped.push({ module: moduleName, ext: "", reason: "all extensions failed" });
		}
	}

	state.loaded = loaded.map((l) => l.module);
	state.loadedCount = total;
	state.skipped = skipped;

	log.info(`Loaded ${total} extensions across ${loaded.length} modules (src: ${source})` +
		(skipped.length > 0 ? `, ${skipped.length} skipped` : ""));

	return { loaded, skipped, total, source };
}

// ──── Runtime toggling API (for researcher subagents) ────────────────────────

/** Enable a module. Persists to pi's settings.json for next session. */
export function enableModule(name: string, ctx?: ExtensionContext): boolean {
	const def = getModuleDef(name);
	if (!def) return false;
	if (def.alwaysOn) return true;
	const state = getLoaderState(ctx);
	state.runtimeConfig.set(name, true);
	saveModuleOverridesToFile(state.runtimeConfig);
	return true;
}

/** Disable a module. Persists to pi's settings.json for next session. */
export function disableModule(name: string, ctx?: ExtensionContext): boolean {
	const def = getModuleDef(name);
	if (!def) return false;
	if (def.alwaysOn) return false;
	const state = getLoaderState(ctx);
	state.runtimeConfig.set(name, false);
	saveModuleOverridesToFile(state.runtimeConfig);
	return true;
}

/** Toggle a module on/off. Returns the new state or null. */
export function toggleModule(name: string, ctx?: ExtensionContext): boolean | null {
	const def = getModuleDef(name);
	if (!def) return null;
	if (def.alwaysOn) return true;
	const state = getLoaderState(ctx);
	const current = state.runtimeConfig.get(name);
	const next = current === undefined ? true : !current;
	state.runtimeConfig.set(name, next);
	saveModuleOverridesToFile(state.runtimeConfig);
	return next;
}

/** Get the current state of all modules with loading status. */
export function getModuleStates(ctx?: ExtensionContext): Record<string, { enabled: boolean; loaded: boolean; source: string; description: string }> {
	const state = getLoaderState(ctx);
	const { enabled, source } = resolveEnabledModules();
	const result: Record<string, { enabled: boolean; loaded: boolean; source: string; description: string }> = {};
	for (const def of MODULE_DEFINITIONS) {
		const isEnabled = state.runtimeConfig.has(def.name)
			? state.runtimeConfig.get(def.name)!
			: enabled.includes(def.name);
		result[def.name] = {
			enabled: isEnabled,
			loaded: state.loaded.includes(def.name),
			source,
			description: def.description,
		};
	}
	return result;
}

/** Reset all runtime overrides (does NOT clear settings.json). */
export function resetModuleOverrides(ctx?: ExtensionContext): void {
	getLoaderState(ctx).runtimeConfig.clear();
}

// ──── Helpers ────────────────────────────────────────────────────────────────

function topologicalSort(moduleNames: string[]): string[] {
	const visited = new Set<string>();
	const visiting = new Set<string>();
	const sorted: string[] = [];

	function visit(name: string): void {
		if (visited.has(name)) return;
		if (visiting.has(name)) throw new Error(`Circular module dependency: ${name}`);
		visiting.add(name);
		const def = getModuleDef(name);
		if (def?.dependencies) {
			for (const dep of def.dependencies) {
				if (moduleNames.includes(dep) || getModuleDef(dep)?.alwaysOn) {
					visit(dep);
				}
			}
		}
		visiting.delete(name);
		visited.add(name);
		sorted.push(name);
	}

	const allNames = [...new Set([
		...getDefaultEnabledModules().filter((n) => getModuleDef(n)?.alwaysOn),
		...moduleNames,
	])];
	for (const name of allNames) visit(name);
	return sorted;
}
