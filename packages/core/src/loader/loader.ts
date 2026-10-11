/**
 * Extension loader - flat loading with runtime toggling.
 *
 * Config layers (applied high -> low; runtime and settings override the
 * layers below per-id, the env var is a complete spec over the defaults):
 *   1. Runtime overrides - /modules-toggle, /modules-enable, /modules-disable
 *      (in-session; the toggle commands also persist them into `braid.modules`)
 *   2. Pi's native settings - `braid.modules` property in ~/.pi/agent/settings.json
 *      (true enables an opt-in id, false disables a default-enabled one)
 *   3. Environment variable - BRAID_MODULES (+id to enable, -id to disable)
 *   4. Default - all extensions enabled (except opt-in/disabledByDefault)
 *
 * The loader works on individual extensions from the flat manifest. The
 * `module` field on each entry is a convenience label for the subagent API -
 * it has no structural role in the directory tree.
 *
 * Config references can be:
 *   - An extension ID (e.g. "enforcement", "three-memory-stores")
 *   - A module group name (e.g. "core", "memory") - expands to all member IDs
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createLogger } from "../lib/core/logger.js";
import { initModels } from "../lib/ai/models-init.js";
import { recordToolRegistration } from "../lib/state/tool-provenance.js";

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

// ──── Tool provenance wrapping ───────────────────────────────────────────────

/**
 * Returns a wrapper around `pi` where `registerTool` records the
 * registering extension id into the tool-provenance map. Other
 * methods pass through unchanged.
 *
 * The wrapper exists because calling `pi.getAllTools()` during
 * extension loading triggers "Extension runtime not initialized" in
 * pi-core (it's an action method that requires the runtime to be
 * ready). The previous before/after diff approach hit this; wrapping
 * `registerTool` is a passive observer pattern that doesn't depend
 * on runtime state.
 */
function wrapForProvenance(pi: ExtensionAPI, extId: string): ExtensionAPI {
  const origRegister = (
    pi as unknown as { registerTool: (t: unknown) => unknown }
  ).registerTool.bind(pi) as (t: unknown) => unknown;
  return new Proxy(pi as unknown as object, {
    get(target, prop, receiver) {
      if (prop === "registerTool") {
        return (tool: unknown) => {
          const name = (tool as { name?: string })?.name;
          if (typeof name === "string" && name.length > 0) {
            recordToolRegistration(name, extId);
          }
          return origRegister(tool);
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  }) as unknown as ExtensionAPI;
}

// ──── Pi settings.json persistence ───────────────────────────────────────────

function readSettingsFile(path: string): Record<string, unknown> {
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch (e) {
    // Missing file = fresh install, silent. Anything else (truncated write,
    // trailing comma, EACCES) silently reverts every braid setting unless it
    // is surfaced.
    if ((e as NodeJS.ErrnoException)?.code !== "ENOENT") warnUnreadableSettings(path, e);
    return {};
  }
}

/** Warned once per process about an unreadable settings file. */
let _warnedUnreadableSettings = false;

function warnUnreadableSettings(path: string, e: unknown): void {
  if (_warnedUnreadableSettings) return;
  _warnedUnreadableSettings = true;
  log.warn(
    `Cannot read settings file at ${path} - braid settings in it are ignored ` +
      "until the file is fixed.",
    { error: (e as Error).message },
  );
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

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Merge `modules` into the project settings file, destroying nothing: only
 * the `braid.modules` keys being written change; sibling keys (braid.* and
 * top-level) and untouched module entries survive.
 *
 * An unreadable existing file is never overwritten - content we could not
 * read must not be replaced from a partial view; the write aborts with the
 * once-per-process unreadable-settings warning instead.
 */
function writeBraidSettings(modules: Record<string, boolean>): void {
  const projectPath = getProjectSettingsPath();
  if (!projectPath) {
    log.warn("Cannot determine project path for settings write");
    return;
  }
  let all: Record<string, unknown>;
  try {
    all = JSON.parse(readFileSync(projectPath, "utf-8")) as Record<string, unknown>;
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code === "ENOENT") {
      all = {};
    } else {
      warnUnreadableSettings(projectPath, e);
      return;
    }
  }
  const existingBraid = isPlainObject(all[BRAID_KEY]) ? all[BRAID_KEY] : {};
  const existingModules = isPlainObject(existingBraid.modules) ? existingBraid.modules : {};
  all[BRAID_KEY] = { ...existingBraid, modules: { ...existingModules, ...modules } };
  try {
    mkdirSync(dirname(projectPath), { recursive: true });
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
  writeBraidSettings(modules);
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

  // Priority 1: runtime overrides overlay the resolved base per-id, so an
  // in-process toggle can never drop settings-file additions or env-var
  // enables - and an opt-in enable is visible to the resolver.
  if (state.runtimeConfig.size > 0) {
    const base = resolveFromSources(env);
    const enabled = new Set(base.enabled);
    for (const [id, override] of state.runtimeConfig) {
      if (override) enabled.add(id);
      else enabled.delete(id);
    }
    return { enabled: [...enabled], source: "runtime-api" };
  }
  return resolveFromSources(env);
}

/**
 * Boot-time resolution, layered high -> low; one function is the truth for
 * boot, the runtime API overlay and getModuleStates:
 *
 *   1. env var (when set): a complete spec that replaces the default set
 *   2. settings.json braid.modules: per-ref boolean overlay (true enables,
 *      false disables), so a persisted entry cannot shadow what the env var
 *      enabled elsewhere
 *   3. defaults
 *
 * The reported source is the highest-priority layer that contributed.
 */
function resolveFromSources(env: string | null): ResolvedConfig {
  const defaults = getDefaultEnabledIds();
  const enabled = new Set(defaults);
  let source: ResolvedConfig["source"] = "defaults";

  // Priority 3: Environment variable
  if (env && env.trim()) {
    const parts = env
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const disabled = new Set<string>();
    const envEnabled = new Set<string>();
    for (const part of parts) {
      if (part.startsWith("+")) {
        for (const id of expandRef(part.slice(1))) envEnabled.add(id);
      } else if (part.startsWith("-")) {
        for (const id of expandRef(part.slice(1))) disabled.add(id);
      } else {
        for (const id of expandRef(part)) envEnabled.add(id);
      }
    }
    if (envEnabled.size > 0) {
      enabled.clear();
      for (const id of envEnabled) enabled.add(id);
    }
    for (const id of disabled) enabled.delete(id);
    source = "env-var";
  }

  // Priority 2: Pi's settings.json -> braid.modules. Refs expand regardless
  // of the value, so a persisted false disables a default-enabled extension;
  // a true enables an opt-in id.
  const settingsOverrides = readModuleOverridesFromSettings();
  if (Object.keys(settingsOverrides).length > 0) {
    for (const [ref, val] of Object.entries(settingsOverrides)) {
      for (const id of expandRef(ref)) {
        if (val) enabled.add(id);
        else enabled.delete(id);
      }
    }
    source = "settings-json";
  }

  return { enabled: [...enabled], source };
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

  // Initialize the pi-ai Models instance before loading extensions.
  // Auxiliary LLM calls do not read it: llm-call.ts dispatches through the
  // session's model registry. See lib/ai/models-init.ts for the current state.
  await initModels();

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
      // Wrap pi.registerTool so the extension's tool registrations
      // are attributed to this extension id in the provenance map.
      // Calling pi.getAllTools() during loading triggers
      // "Extension runtime not initialized" in pi-core - the wrap
      // approach avoids that entirely.
      const extPi = wrapForProvenance(pi, extId);
      await entry.fn(extPi);
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
    `Loaded ${total} extensions` + (skipped.length > 0 ? `, ${skipped.length} skipped` : ""),
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
  // Flip the EFFECTIVE state (one resolution path), not the last runtime
  // value: a toggle on a default-enabled extension with no prior override
  // must turn it off, not "toggled ON" on an already-on extension.
  const target = nonAlwaysOn[0]; // Use first non-alwaysOn as toggle indicator
  const next = !resolveEnabledExtensions().enabled.includes(target);
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
    // One resolution path: the resolver already applies runtime overrides,
    // settings and env - consulting runtimeConfig here would produce a
    // second answer in the same process.
    const isEnabled = enabled.includes(entry.id);
    result[entry.id] = {
      enabled: isEnabled,
      loaded: state.loaded.includes(entry.id),
      source,
      desc: entry.desc,
    };
  }
  return result;
}

/**
 * Reset all runtime overrides. Persisted braid.modules settings are data the
 * user owns - reset clears the in-process layer only; a merge write that
 * wiped them would destroy hand-authored entries (the same data-loss class
 * as sibling-key destruction).
 */
export function resetModuleOverrides(_ctx?: ExtensionContext): void {
  getLoaderState().runtimeConfig.clear();
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
