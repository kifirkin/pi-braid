/**
 * Module loader — flat extension loading with runtime toggling.
 *
 * Config sources (priority: high → low):
 *   1. Runtime subagent API — /modules-toggle, /modules-enable, /modules-disable
 *   2. Pi's native settings — `braid.modules` property in ~/.pi/agent/settings.json
 *   3. Environment variable — BRAID_MODULES (+id to enable, -id to disable)
 *   4. Default — all extensions enabled (except opt-in/disabledByDefault)
 *
 * Unlike the previous module system (ModuleDef groups), this loader works
 * on individual extensions from the flat manifest. The `module` tag on each
 * entry is just a convenience label for the subagent API — no structural role.
 *
 * Config references can be:
 *   - An extension ID (e.g. "enforcement", "three-memory-stores")
 *   - A module group name (e.g. "core", "memory") — expands to all member IDs
 */

import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createLogger } from "../lib/core/logger.js";

import {
  MANIFEST,
  getEntry,
  getModuleGroup,
  getModuleNames,
  getDefaultEnabledIds,
  getAlwaysOnIds,
} from "../extensions/manifest.js";

const log = createLogger("modules");

// ──── Pi's native settings paths ─────────────────────────────────────────────

const GLOBAL_SETTINGS = join(homedir(), ".pi", "agent", "settings.json");

function getProjectSettingsPath(): string {
  try {
    return join(process.cwd(), ".pi", "settings.json");
  } catch {
    return "";
  }
}

const BRAID_KEY = "braid";

interface BraidSettings {
  modules?: Record<string, boolean>;
}

// ──── Runtime config store ───────────────────────────────────────────────────

interface ModuleLoaderState {
  runtimeConfig: Map<string, boolean>;
  loaded: string[];
  loadedCount: number;
  skipped: { id: string; reason: string }[];
}

const _loaderState: ModuleLoaderState = {
  runtimeConfig: new Map(),
  loaded: [],
  loadedCount: 0,
  skipped: [],
};

function getLoaderState(): ModuleLoaderState {
  return _loaderState;
}

// ──── Pi settings.json persistence ───────────────────────────────────────────

function readSettingsFile(path: string): Record<string, unknown> {
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return {};
  }
}

function readBraidSettings(): BraidSettings {
  const global_ = readSettingsFile(GLOBAL_SETTINGS);
  const projectPath = getProjectSettingsPath();
  const project_ = projectPath ? readSettingsFile(projectPath) : {};

  const globalModules = (global_[BRAID_KEY] as BraidSettings)?.modules ?? {};
  const projectModules = (project_[BRAID_KEY] as BraidSettings)?.modules ?? {};

  const merged: Record<string, boolean> = { ...globalModules };
  for (const [k, v] of Object.entries(projectModules)) {
    merged[k] = v;
  }

  return { modules: Object.keys(merged).length > 0 ? merged : undefined };
}

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

function readModuleOverridesFromSettings(): Record<string, boolean> {
  const braid = readBraidSettings();
  return braid.modules ?? {};
}

function saveModuleOverridesToFile(overrides: Map<string, boolean>): void {
  const modules: Record<string, boolean> = {};
  for (const [name, val] of overrides) {
    modules[name] = val;
  }
  writeBraidSettings({ modules });
}

// ──── Config expansion ──────────────────────────────────────────────────────

/**
 * Expand a config reference (extension ID or module group name) into
 * individual extension IDs.
 */
function expandRef(ref: string): string[] {
  // Direct extension ID match
  if (getEntry(ref)) return [ref];
  // Module group name
  const group = getModuleGroup(ref);
  if (group.length > 0) return group.map((e) => e.id);
  return [];
}

/** All valid config references (extension IDs + module group names). */
function allConfigRefs(): string[] {
  const ids = MANIFEST.map((e) => e.id);
  const groups = getModuleNames();
  return [...new Set([...ids, ...groups])];
}

// ──── Config resolution ──────────────────────────────────────────────────────

export interface ResolvedConfig {
  enabled: string[];
  source: "runtime-api" | "settings-json" | "env-var" | "defaults";
}

/** Resolve which extensions are enabled, tracing the config source. */
export function resolveEnabledExtensions(envOverride?: string): ResolvedConfig {
  const state = getLoaderState();
  const env = envOverride ?? process.env.BRAID_MODULES ?? null;
  const defaults = getDefaultEnabledIds();

  // Priority 1: Runtime API overrides
  if (state.runtimeConfig.size > 0) {
    const enabled = defaults.filter((id) => {
      const override = state.runtimeConfig.get(id);
      return override !== undefined ? override : true;
    });
    return { enabled, source: "runtime-api" };
  }

  // Priority 2: Pi's settings.json → braid.modules
  const settingsOverrides = readModuleOverridesFromSettings();
  if (Object.keys(settingsOverrides).length > 0) {
    const enabled: string[] = [];
    const seen = new Set<string>();
    for (const [ref, val] of Object.entries(settingsOverrides)) {
      const ids = val ? expandRef(ref) : [];
      for (const id of ids) {
        if (!seen.has(id)) {
          seen.add(id);
          enabled.push(id);
        }
      }
    }
    // Also keep any defaults not mentioned in settings
    for (const id of defaults) {
      if (!seen.has(id)) {
        seen.add(id);
        enabled.push(id);
      }
    }
    return { enabled, source: "settings-json" };
  }

  // Priority 3: Environment variable
  if (env && env.trim()) {
    const parts = env
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const disabled = new Set<string>();
    const enabled = new Set<string>();
    for (const part of parts) {
      if (part.startsWith("+")) {
        for (const id of expandRef(part.slice(1))) enabled.add(id);
      } else if (part.startsWith("-")) {
        for (const id of expandRef(part.slice(1))) disabled.add(id);
      } else {
        for (const id of expandRef(part)) enabled.add(id);
      }
    }
    if (enabled.size > 0)
      return { enabled: [...enabled].filter((id) => !disabled.has(id)), source: "env-var" };
    return { enabled: defaults.filter((id) => !disabled.has(id)), source: "env-var" };
  }

  // Priority 4: Defaults
  return { enabled: defaults, source: "defaults" };
}

// ──── Loading ────────────────────────────────────────────────────────────────

export interface LoadReport {
  loaded: { id: string; desc: string }[];
  skipped: { id: string; reason: string }[];
  total: number;
  source: string;
}

/**
 * Load all enabled extensions based on resolved config.
 * Calls each factory with the pi API.
 */
export async function loadModules(pi: ExtensionAPI, envOverride?: string): Promise<LoadReport> {
  const state = getLoaderState();
  const { enabled, source } = resolveEnabledExtensions(envOverride);
  const loaded: LoadReport["loaded"] = [];
  const skipped: LoadReport["skipped"] = [];
  let total = 0;

  log.info(`Loading extensions from config: ${source}`);
  log.info(`Enabled: ${enabled.join(", ")}`);

  const ordered = topologicalSort(enabled);

  for (const extId of ordered) {
    const entry = getEntry(extId);
    if (!entry) {
      skipped.push({ id: extId, reason: "unknown extension" });
      continue;
    }
    try {
      await entry.fn(pi);
      total++;
      loaded.push({ id: extId, desc: entry.desc });
    } catch (err) {
      skipped.push({ id: extId, reason: (err as Error).message });
      log.error(`Failed to load ${extId}: ${(err as Error).message}`);
    }
  }

  state.loaded = loaded.map((l) => l.id);
  state.loadedCount = total;
  state.skipped = skipped;

  log.info(
    `Loaded ${total} extensions` +
      (skipped.length > 0 ? `, ${skipped.length} skipped` : ""),
  );

  return { loaded, skipped, total, source };
}

// ──── Runtime toggling API ───────────────────────────────────────────────────

/**
 * Resolve a config reference to individual extension IDs.
 * Returns null if the reference is unknown.
 */
function resolveIds(ref: string): string[] | null {
  // Direct extension ID
  if (getEntry(ref)) return [ref];
  // Module group name
  const group = getModuleGroup(ref);
  if (group.length > 0) return group.map((e) => e.id);
  return null;
}

/** Enable an extension (or module group). Persists to settings.json. */
export function enableModule(name: string, _ctx?: ExtensionContext): boolean {
  const ids = resolveIds(name);
  if (!ids) return false;
  const state = getLoaderState();
  const nonAlwaysOn = ids.filter((id) => !getEntry(id)?.alwaysOn);
  if (nonAlwaysOn.length === 0) return true;
  for (const id of nonAlwaysOn) state.runtimeConfig.set(id, true);
  saveModuleOverridesToFile(state.runtimeConfig);
  return true;
}

/** Disable an extension (or module group). Persists to settings.json. */
export function disableModule(name: string, _ctx?: ExtensionContext): boolean {
  const ids = resolveIds(name);
  if (!ids) return false;
  const nonAlwaysOn = ids.filter((id) => !getEntry(id)?.alwaysOn);
  if (nonAlwaysOn.length === 0) return false;
  const state = getLoaderState();
  for (const id of nonAlwaysOn) state.runtimeConfig.set(id, false);
  saveModuleOverridesToFile(state.runtimeConfig);
  return true;
}

/** Toggle an extension (or module group). Returns the new state or null. */
export function toggleModule(name: string, _ctx?: ExtensionContext): boolean | null {
  const ids = resolveIds(name);
  if (!ids) return null;
  const nonAlwaysOn = ids.filter((id) => !getEntry(id)?.alwaysOn);
  if (nonAlwaysOn.length === 0) return true;
  const state = getLoaderState();
  const target = nonAlwaysOn[0]; // Use first non-alwaysOn as toggle indicator
  const current = state.runtimeConfig.get(target);
  const next = current === undefined ? true : !current;
  for (const id of nonAlwaysOn) state.runtimeConfig.set(id, next);
  saveModuleOverridesToFile(state.runtimeConfig);
  return next;
}

/** Get the current state of all extensions with loading status. */
export function getModuleStates(
  _ctx?: ExtensionContext,
): Record<string, { enabled: boolean; loaded: boolean; source: string; desc: string }> {
  const state = getLoaderState();
  const { enabled, source } = resolveEnabledExtensions();
  const result: Record<
    string,
    { enabled: boolean; loaded: boolean; source: string; desc: string }
  > = {};
  for (const entry of MANIFEST) {
    const isEnabled = state.runtimeConfig.has(entry.id)
      ? state.runtimeConfig.get(entry.id)!
      : enabled.includes(entry.id);
    result[entry.id] = {
      enabled: isEnabled,
      loaded: state.loaded.includes(entry.id),
      source,
      desc: entry.desc,
    };
  }
  return result;
}

/** Reset all runtime overrides and clears settings.json. */
export function resetModuleOverrides(_ctx?: ExtensionContext): void {
  const state = getLoaderState();
  state.runtimeConfig.clear();
  saveModuleOverridesToFile(new Map());
}

// ──── Helpers ────────────────────────────────────────────────────────────────

/**
 * Topological sort by dependency chain.
 * Always includes alwaysOn extensions first, then sorts remaining by dep order.
 */
function topologicalSort(extIds: string[]): string[] {
  const alwaysOn = getAlwaysOnIds();
  const inputSet = new Set([...alwaysOn, ...extIds]);
  const visited = new Set<string>();
  const visiting = new Set<string>();
  const sorted: string[] = [];

  function visit(id: string): void {
    if (visited.has(id)) return;
    if (visiting.has(id)) throw new Error(`Circular extension dependency: ${id}`);
    visiting.add(id);
    const entry = getEntry(id);
    if (entry?.dependencies) {
      for (const dep of entry.dependencies) {
        if (inputSet.has(dep)) visit(dep);
      }
    }
    visiting.delete(id);
    visited.add(id);
    sorted.push(id);
  }

  // Visit alwaysOn first, then remaining input
  for (const id of alwaysOn) if (inputSet.has(id)) visit(id);
  for (const id of extIds) if (!alwaysOn.includes(id)) visit(id);

  return sorted;
}

/** Get all valid config reference names for API completion/docs. */
export function getAllRefNames(): string[] {
  return allConfigRefs();
}

export { getAllRefNames as getAllModuleNames };