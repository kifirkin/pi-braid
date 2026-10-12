#!/usr/bin/env node
/**
 * gen-braid-schema.mjs — derive the braid.* settings surface from its readers.
 *
 * The braid.* settings keys are read across a fixed set of reader files (the
 * allowlist below). This script emits packages/core/schema/braid.schema.json,
 * a JSON Schema (draft 2020-12) mirroring the key paths, so the documented
 * surface is machine-checkable instead of hand-maintained.
 *
 * Derivation has two arms, mirroring check-doc-drift.mjs's SOURCE_CLAIMS
 * discipline (every pattern must match, every match must equal the
 * recomputed value):
 *
 *   mechanical — the default is not stated here. The row names a defaults
 *     constant (DEFAULTS-style object literal or scalar `export const`) that
 *     lives in one of the reader files; the literal is extracted from that
 *     source text at generation time. Edit the code default, regenerate, and
 *     the artifact follows — the generator never restates a code value.
 *
 *   overlay — keys whose default is not a mechanically extractable literal
 *     (derived precedence, "unset" semantics, built-in paths). Each overlay
 *     row carries path, type, default, and a source `file:line` plus the
 *     exact evidence text that line must contain; a row that cannot prove
 *     its key exists in source fails the generator.
 *
 * Reader allowlist is explicit (not a directory walk): a new reader file
 * must be added here on purpose, the same way SOURCE_CLAIMS rows are added.
 *
 * Output is byte-stable: sorted keys, 2-space indent, trailing newline.
 * `additionalProperties` is left unconstrained — the schema documents the
 * surface, it does not police pi's settings document.
 *
 * Usage: node scripts/gen-braid-schema.mjs   (writes the artifact, prints
 * the coverage line, exit 0; any validation failure exits 1 loudly)
 */

import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(__dirname, "..", "..", "..");

/** The reader files the braid.* surface is derived from. Explicit allowlist. */
export const READER_FILES = [
  "packages/core/src/lib/config/braid-settings.ts",
  "packages/core/src/lib/config/per-tool-settings.ts",
  "packages/core/src/lib/memory/write-quality.ts",
  "packages/core/src/loader/loader.ts",
  "packages/contrib/browser/index.ts",
  "packages/contrib/path-security/index.ts",
  "packages/contrib/rate-limiter/index.ts",
  "packages/contrib/rate-limiter/settings.ts",
  "packages/contrib/observatory/index.ts",
  "packages/contrib/network-monitor/index.ts",
  "packages/contrib/index.ts",
  "packages/providers/presend-guard.ts",
  "packages/providers/ring-lifecycle.ts",
  "packages/telegram/src/lib/telegram-settings.ts",
  "packages/telegram/src/lib/pause-control.ts",
];

const CORE = "packages/core";
const SETTINGS = `${CORE}/src/lib/config/braid-settings.ts`;

/**
 * Defaults constants the mechanical rows bind to, with the file each lives in.
 * The property values are extracted from source at generation time.
 */
const CONST_SOURCES = {
  DEFAULT_TIME_ZONE: SETTINGS,
  MEMORY_WRITE_GATE_DEFAULTS: `${CORE}/src/lib/memory/write-quality.ts`,
  MAX_WAKE_ATTEMPTS_DEFAULT: SETTINGS,
  WAKE_DELIVERY_ALERT_DEFAULT: SETTINGS,
  TOOL_RESULT_SIZE_CAP_DEFAULTS: SETTINGS,
  AUTO_COMPACT_DEFAULTS: SETTINGS,
  STALE_TOOL_RESULT_OFFLOAD_DEFAULTS: SETTINGS,
  CONTEXT_EMERGENCY_OFFLOAD_DEFAULTS: SETTINGS,
  TERMINAL_BREAKER_DEFAULT_THRESHOLD: SETTINGS,
  OVER_CORRECTION_GATE_DEFAULTS: SETTINGS,
  PRESGUARD_DEFAULT_ENABLED: "packages/providers/presend-guard.ts",
  DEFAULT_SEND_MAX_CHARS: "packages/telegram/src/lib/telegram-settings.ts",
  DEFAULT_NOTIFY_MAX_CHARS: "packages/telegram/src/lib/telegram-settings.ts",
  DEFAULTS: "packages/contrib/network-monitor/index.ts",
};

/**
 * Mechanically derived rows: the default is extracted from the named
 * constant (in CONST_SOURCES' file), the read site proves the key exists.
 * `prop` selects a field of an object literal; null for scalar constants.
 */
const MECHANICAL_ROWS = [
  {
    path: "braid.timezone",
    type: "string",
    description: "Owner time zone (IANA) for local-time rendering.",
    read: { file: SETTINGS, line: 481, evidence: "settings.braid?.timezone" },
    mech: { const: "DEFAULT_TIME_ZONE", prop: null },
  },
  {
    path: "braid.memory.writeGate.enabled",
    type: "boolean",
    description: "Review-before-write quality gate on durable episode writes.",
    read: { file: SETTINGS, line: 429, evidence: "settings.braid?.memory?.writeGate" },
    mech: { const: "MEMORY_WRITE_GATE_DEFAULTS", prop: "enabled" },
  },
  {
    path: "braid.memory.writeGate.cooldownMs",
    type: "number",
    description: "Minimum interval between gated heartbeat writes (anti-thrash).",
    read: { file: SETTINGS, line: 429, evidence: "settings.braid?.memory?.writeGate" },
    mech: { const: "MEMORY_WRITE_GATE_DEFAULTS", prop: "cooldownMs" },
  },
  {
    path: "braid.memory.writeGate.mode",
    type: "string",
    enum: ["enforce", "warn"],
    description: 'Apply gate decisions ("enforce") or log them and write anyway ("warn").',
    read: { file: SETTINGS, line: 429, evidence: "settings.braid?.memory?.writeGate" },
    mech: { const: "MEMORY_WRITE_GATE_DEFAULTS", prop: "mode" },
  },
  {
    path: "braid.timers.maxWakeAttempts",
    type: "integer",
    description: "Redelivery bound for a failed timer wake fire before drop.",
    read: { file: SETTINGS, line: 935, evidence: "readSettings().braid?.timers?.maxWakeAttempts" },
    mech: { const: "MAX_WAKE_ATTEMPTS_DEFAULT", prop: null },
  },
  {
    path: "braid.enforcement.overCorrectionGate.mode",
    type: "string",
    enum: ["off", "shadow", "on"],
    description:
      'Accusation-triggered irreversible-action gate: "off" (inert, default), "shadow" (whisper only), "on" (whisper + block).',
    read: { file: SETTINGS, line: 415, evidence: "readSettings().braid?.enforcement?.overCorrectionGate" },
    mech: { const: "OVER_CORRECTION_GATE_DEFAULTS", prop: "mode" },
  },
  {
    path: "braid.timers.wakeAlert.mode",
    type: "string",
    enum: ["on", "off"],
    description: 'Feed timer wake-stall facts to the watchdog; "off" disables the feed.',
    read: { file: SETTINGS, line: 1071, evidence: "readSettings().braid?.timers?.wakeAlert" },
    mech: { const: "WAKE_DELIVERY_ALERT_DEFAULT", prop: "mode" },
  },
  {
    path: "braid.timers.wakeAlert.outcomeTimeouts",
    type: "integer",
    description: "Outcome timeouts for one fire before the early stall page.",
    read: { file: SETTINGS, line: 1071, evidence: "readSettings().braid?.timers?.wakeAlert" },
    mech: { const: "WAKE_DELIVERY_ALERT_DEFAULT", prop: "outcomeTimeouts" },
  },
  {
    path: "braid.context.toolResultSizeCap.enabled",
    type: "boolean",
    description: "Capture-time cap: oversized tool results flushed to disk + stubbed.",
    read: { file: SETTINGS, line: 792, evidence: "readSettings().braid?.context?.toolResultSizeCap" },
    mech: { const: "TOOL_RESULT_SIZE_CAP_DEFAULTS", prop: "enabled" },
  },
  {
    path: "braid.context.toolResultSizeCap.maxChars",
    type: "number",
    description: "Size above which a captured tool result is flushed + stubbed.",
    read: { file: SETTINGS, line: 792, evidence: "readSettings().braid?.context?.toolResultSizeCap" },
    mech: { const: "TOOL_RESULT_SIZE_CAP_DEFAULTS", prop: "maxChars" },
  },
  {
    path: "braid.context.contextAutoCompact.enabled",
    type: "boolean",
    description: "Usage-driven auto-arm of a deterministic slide compaction.",
    read: { file: SETTINGS, line: 885, evidence: "readSettings().braid?.context?.contextAutoCompact" },
    mech: { const: "AUTO_COMPACT_DEFAULTS", prop: "enabled" },
  },
  {
    path: "braid.context.contextAutoCompact.armPercent",
    type: "number",
    description: "Usage percent at or above which an observation counts toward arming.",
    read: { file: SETTINGS, line: 885, evidence: "readSettings().braid?.context?.contextAutoCompact" },
    mech: { const: "AUTO_COMPACT_DEFAULTS", prop: "armPercent" },
  },
  {
    path: "braid.context.contextAutoCompact.confirmTicks",
    type: "integer",
    description: "Consecutive above-threshold observations required before arming.",
    read: { file: SETTINGS, line: 885, evidence: "readSettings().braid?.context?.contextAutoCompact" },
    mech: { const: "AUTO_COMPACT_DEFAULTS", prop: "confirmTicks" },
  },
  ...staleOffloadRows(),
  ...emergencyOffloadRows(),
  {
    path: "braid.context.presendGuard.enabled",
    type: "boolean",
    description: "Pre-send shrink guard against a model's context window.",
    read: {
      file: "packages/providers/presend-guard.ts",
      line: 68,
      evidence: "raw?.braid?.context?.presendGuard?.enabled",
    },
    mech: { const: "PRESGUARD_DEFAULT_ENABLED", prop: null },
  },
  {
    path: "braid.session.terminalBreaker.threshold",
    type: "integer",
    description: "Terminal-class errors before timer wakes stop starting turns.",
    read: { file: SETTINGS, line: 997, evidence: "readSettings().braid?.session?.terminalBreaker" },
    mech: { const: "TERMINAL_BREAKER_DEFAULT_THRESHOLD", prop: null },
  },
  {
    path: "braid.telegram.sendMaxChars",
    type: "number",
    description: "Default cap for telegram_send plain text.",
    read: {
      file: "packages/telegram/src/lib/telegram-settings.ts",
      line: 72,
      evidence: "telegram?.sendMaxChars",
    },
    mech: { const: "DEFAULT_SEND_MAX_CHARS", prop: null },
  },
  {
    path: "braid.telegram.notifyMaxChars",
    type: "number",
    description: "Craft target + guard for turn-end notifications.",
    read: {
      file: "packages/telegram/src/lib/telegram-settings.ts",
      line: 73,
      evidence: "notifyMaxChars: sanitizeCap(",
    },
    mech: { const: "DEFAULT_NOTIFY_MAX_CHARS", prop: null },
  },
  ...networkMonitorRows(),
];

function staleOffloadRows() {
  const prefix = "braid.context.staleToolResultOffload";
  const fields = [
    ["enabled", "boolean", "Age/size offload of stale large tool results; OFF unless opted in."],
    ["minChars", "number", "Minimum result size (chars) to be eligible."],
    ["stalenessTurns", "integer", "Minimum age (tool results since) to be eligible."],
    ["keepRecentTurns", "integer", "Never touch the last N tool results."],
    ["maxOffloadCharsPerRun", "number", "Per-LLM-call offload budget."],
  ];
  return fields.map(([leaf, type, description]) => ({
    path: `${prefix}.${leaf}`,
    type,
    description,
    read: {
      file: SETTINGS,
      line: 610,
      evidence: "readSettings().braid?.context?.staleToolResultOffload",
    },
    mech: { const: "STALE_TOOL_RESULT_OFFLOAD_DEFAULTS", prop: leaf },
  }));
}

function emergencyOffloadRows() {
  const prefix = "braid.context.contextEmergencyOffload";
  const fields = [
    ["enabled", "boolean", "On a 413, shrink the largest tool results and retry once."],
    ["minChars", "number", "Size floor (chars) for emergency eligibility."],
    ["maxCharsPerRun", "number", "Per-run offload budget."],
    ["keepRecentTurns", "integer", "Keep the latest tool result visible in an emergency."],
  ];
  return fields.map(([leaf, type, description]) => ({
    path: `${prefix}.${leaf}`,
    type,
    description,
    read: {
      file: SETTINGS,
      line: 716,
      evidence: "readSettings().braid?.context?.contextEmergencyOffload",
    },
    mech: { const: "CONTEXT_EMERGENCY_OFFLOAD_DEFAULTS", prop: leaf },
  }));
}

function networkMonitorRows() {
  const prefix = "braid.contrib.networkMonitor";
  const fields = [
    ["profileName", "string", "Tunnel profile name the probe watches."],
    ["reachabilityUrl", "string", "URL the probe fetches to decide reachability."],
    ["curlTimeoutSecs", "number", "Per-probe curl timeout."],
    ["disconnectDelayMs", "number", "Delay between detecting a drop and declaring it."],
    ["connectTimeoutMs", "number", "Timeout for the reconnect attempt."],
    ["pollIntervalMs", "number", "Tunnel-state poll interval."],
    ["cooldownMs", "number", "Cooldown between reconnect actions."],
    ["autoReconnect", "boolean", "Reconnect automatically when the tunnel is down."],
    ["autoWatch", "boolean", "Watch the tunnel state without an explicit trigger."],
    ["probeIntervalMs", "number", "Background probe interval."],
    ["maxAttemptsPerOutage", "number", "Reconnect attempts before an outage escalates."],
    ["reconnectCooldownMs", "number", "Cooldown after a successful reconnect."],
    ["logFile", "string", "Append-only log file for watcher lines (empty = off)."],
  ];
  return fields.map(([leaf, type, description]) => ({
    path: `${prefix}.${leaf}`,
    type,
    description,
    read: {
      file: "packages/contrib/network-monitor/index.ts",
      line: 137,
      evidence: "parsed.braid?.contrib?.networkMonitor",
    },
    mech: { const: "DEFAULTS", prop: leaf },
  }));
}

/**
 * Overlay rows: keys whose default is not a mechanically extractable literal.
 * `default` is the documented built-in value (null = no literal default; the
 * effective default is derived or unset). Every row is existence-checked: the
 * named source line must literally contain the evidence text.
 */
const OVERLAY_ROWS = [
  {
    path: "braid.suppressNudges",
    type: "boolean",
    default: false,
    description: "Disable all braid cognitive nudges (enforcement, heartbeat, feedback).",
    read: { file: SETTINGS, line: 333, evidence: "settings.braid?.suppressNudges" },
  },
  {
    path: "braid.enforcement.nudgeConfigs",
    type: "object",
    default: {},
    description: "Per-nudge-type overrides, validated by the NudgeManager.",
    read: { file: SETTINGS, line: 356, evidence: "settings.braid?.enforcement?.nudgeConfigs" },
  },
  {
    path: "braid.memory.writeGate.sites",
    type: "object",
    default: {},
    description: "Per-writer opt-out; unknown site keys are dropped (all sites gated).",
    read: {
      file: `${CORE}/src/lib/memory/write-quality.ts`,
      line: 84,
      evidence: "sites: Partial<Record<WriteGateSite, boolean>>;",
    },
  },
  {
    path: "braid.context.contextLimitTokens",
    type: "number",
    default: null,
    description:
      "Effective window braid computes with (unset falls through to the provider window).",
    read: { file: SETTINGS, line: 1167, evidence: "readSettings().braid?.context?.contextLimitTokens" },
  },
  {
    path: "braid.session.terminalBreaker.enabled",
    type: "boolean",
    default: true,
    description: "Terminal-error wake breaker; false disables the gate entirely.",
    read: { file: SETTINGS, line: 997, evidence: "readSettings().braid?.session?.terminalBreaker" },
  },
  {
    path: "braid.providers.fallback",
    type: "object",
    default: null,
    description: "Legacy fallback provider/model on a ring death; inert when routes are set.",
    read: {
      file: "packages/providers/ring-lifecycle.ts",
      line: 548,
      evidence: "resolveFallbackConfig(providers.fallback)",
    },
  },
  {
    path: "braid.providers.lastResort",
    type: "object",
    default: {},
    description: "Legacy source→leg provider map for dead rings; inert when routes are set.",
    read: {
      file: "packages/providers/ring-lifecycle.ts",
      line: 550,
      evidence: "resolveLastResortMap(providers.lastResort)",
    },
  },
  {
    path: "braid.providers.routes",
    type: "array",
    default: null,
    description: "Ordered provider route table; the only registration-order source when set.",
    read: {
      file: "packages/providers/ring-lifecycle.ts",
      line: 543,
      evidence: '"routes" in providers',
    },
  },
  {
    path: "braid.modules",
    type: "object",
    default: null,
    description: "Per-extension-ref enable/disable overlay (manifest defaults when unset).",
    read: { file: `${CORE}/src/loader/loader.ts`, line: 236, evidence: "braid.modules ?? {}" },
  },
  {
    path: "braid.contrib",
    type: "object",
    default: null,
    description: "Extension toggles and per-extension config.",
    read: { file: "packages/contrib/index.ts", line: 98, evidence: "parsed.braid?.contrib" },
  },
  {
    path: "braid.contrib._global.enabled",
    type: "array",
    default: null,
    description: "Cross-extension tool enable list (all tools when unset).",
    read: {
      file: `${CORE}/src/lib/config/per-tool-settings.ts`,
      line: 189,
      evidence: 'const GLOBAL_KEY = "_global";',
    },
  },
  {
    path: "braid.contrib.<ext>.enabled",
    type: "array",
    default: null,
    description: "Per-tool enable list for one extension (all tools when unset).",
    read: {
      file: `${CORE}/src/lib/config/per-tool-settings.ts`,
      line: 145,
      evidence: "settings.braid?.contrib?.[extensionName]",
    },
    wildcard: true,
  },
  {
    path: "braid.contrib.browserAdvanced",
    type: "boolean",
    default: false,
    description: "Opt in to the heavy browser tools (off by default).",
    read: {
      file: "packages/contrib/browser/index.ts",
      line: 76,
      evidence: "parsed.braid?.contrib?.browserAdvanced === true",
    },
  },
  {
    path: "braid.contrib.pathSecurity",
    type: ["boolean", "object"],
    default: true,
    description: "Path guard; false disables the extension, an object tunes it.",
    read: {
      file: "packages/contrib/path-security/index.ts",
      line: 79,
      evidence: "parsed.braid?.contrib?.pathSecurity",
    },
  },
  {
    path: "braid.contrib.pathSecurity.block",
    type: "boolean",
    default: false,
    description: "Hard-block dangerous paths instead of warn-and-allow.",
    read: {
      file: "packages/contrib/path-security/index.ts",
      line: 87,
      evidence: "block: (ps as { block?: boolean }).block === true",
    },
  },
  {
    path: "braid.contrib.rateLimiter",
    type: "object",
    default: null,
    description: "LLM request/token ceilings. Canonical camelCase key.",
    read: {
      file: "packages/contrib/rate-limiter/settings.ts",
      line: 59,
      evidence: "const canonical = contrib[CANONICAL_KEY];",
    },
  },
  {
    path: "braid.contrib.rate-limiter",
    type: "object",
    default: null,
    description: "Deprecated alias for braid.contrib.rateLimiter (removed after this release).",
    read: {
      file: "packages/contrib/rate-limiter/settings.ts",
      line: 61,
      evidence: "const deprecated = contrib[DEPRECATED_KEY];",
    },
  },
  {
    path: "braid.contrib.rateLimiter.rpm",
    type: "number",
    default: 30,
    description: "Global requests-per-minute ceiling.",
    read: {
      file: "packages/contrib/rate-limiter/settings.ts",
      line: 34,
      evidence: "default: { rpm: 30, tpm: 500_000 },",
    },
  },
  {
    path: "braid.contrib.rateLimiter.tpm",
    type: "number",
    default: 500000,
    description: "Global tokens-per-minute ceiling.",
    read: {
      file: "packages/contrib/rate-limiter/settings.ts",
      line: 34,
      evidence: "default: { rpm: 30, tpm: 500_000 },",
    },
  },
  {
    path: "braid.contrib.observatory",
    type: ["boolean", "object"],
    default: null,
    description: "Observatory extension toggle and config.",
    read: {
      file: "packages/contrib/observatory/index.ts",
      line: 69,
      evidence: "parsed.braid?.contrib?.observatory",
    },
  },
  {
    path: "braid.contrib.observatory.record",
    type: "boolean",
    default: false,
    description: "Persist observatory events to disk (opt-in).",
    read: {
      file: "packages/contrib/observatory/index.ts",
      line: 72,
      evidence: "return { enabled: true, record: false, maxEvents: MAX_EVENTS_PER_SESSION };",
    },
  },
  {
    path: "braid.contrib.networkMonitor",
    type: ["boolean", "object"],
    default: true,
    description: "Tunnel watch/reconnect probe; false disables, an object tunes it.",
    read: {
      file: "packages/contrib/network-monitor/index.ts",
      line: 137,
      evidence: "parsed.braid?.contrib?.networkMonitor",
    },
  },
  {
    path: "braid.telegram.pauseStateFile",
    type: "string",
    default: null,
    description: "Override the Telegram pause-state file location (built-in path when unset).",
    read: {
      file: "packages/telegram/src/lib/pause-control.ts",
      line: 78,
      evidence: "parsed?.braid?.telegram?.pauseStateFile",
    },
  },
];

// ── Extraction ──────────────────────────────────────────────────────────────

/** Evaluate a numeric literal expression (digits, separators, arithmetic). */
function evalNumericLiteral(raw) {
  const s = raw.replace(/_/g, "").trim();
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
  if (/^[\d\s*+().-]+$/.test(s)) {
    const value = Function(`"use strict"; return (${s});`)();
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new Error(`numeric literal expression did not evaluate: ${raw}`);
    }
    return value;
  }
  throw new Error(`not a numeric literal: ${raw}`);
}

/** Parse a TS literal token (string, boolean, number) into a JS value. */
function parseLiteralToken(raw) {
  const s = raw.trim().replace(/,\s*$/, "");
  if (/^"([^"]*)"$/.test(s)) return s.slice(1, -1);
  if (/^'([^']*)'$/.test(s)) return s.slice(1, -1);
  if (s === "true") return true;
  if (s === "false") return false;
  return evalNumericLiteral(s);
}

/**
 * Strip comments from TS source, respecting string literals (so a `//` inside
 * a URL string survives). Needed because the DEFAULTS literals carry JSDoc.
 */
function stripComments(text) {
  let out = "";
  let i = 0;
  let quote = null;
  while (i < text.length) {
    const ch = text[i];
    if (quote) {
      out += ch;
      if (ch === "\\") out += text[i + 1] ?? "";
      if (i++, ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
      out += ch;
      i++;
      continue;
    }
    if (ch === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      continue;
    }
    if (ch === "/" && text[i + 1] === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

/**
 * Extract a defaults constant from source text: a scalar `const NAME = <lit>;`
 * or a flat object literal `const NAME = { key: <lit>, ... }`. Values may be
 * numeric literal expressions (e.g. `20 * 60 * 1000`); nested objects are not
 * supported and fail loudly.
 */
export function extractConstDefault(text, constName, prop) {
  const decl = new RegExp(`(?:export\\s+)?const\\s+${constName}\\b[^=;{]*=\\s*`);
  const m = text.match(decl);
  if (!m) throw new Error(`defaults constant not found: ${constName}`);
  const rest = stripComments(text.slice(m.index + m[0].length));
  if (rest.startsWith("{")) {
    let depth = 0;
    let end = -1;
    for (let i = 0; i < rest.length; i++) {
      if (rest[i] === "{") depth++;
      else if (rest[i] === "}") {
        depth--;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    if (end < 0) throw new Error(`unbalanced object literal for ${constName}`);
    const body = rest.slice(1, end);
    const entries = {};
    for (const em of body.matchAll(/([A-Za-z_]\w*)\s*:\s*([\s\S]*?)(?=,\s*[A-Za-z_]\w*\s*:|,\s*$|$)/gm)) {
      entries[em[1]] = parseLiteralToken(em[2]);
    }
    if (prop === null) {
      throw new Error(`constant ${constName} is an object literal; a property is required`);
    }
    if (!(prop in entries)) {
      throw new Error(`property ${prop} not found in constant ${constName}`);
    }
    return entries[prop];
  }
  if (prop !== null) {
    throw new Error(`constant ${constName} is scalar; no property to select`);
  }
  const semi = rest.indexOf(";");
  if (semi < 0) throw new Error(`no terminating semicolon after ${constName}`);
  return parseLiteralToken(rest.slice(0, semi));
}

/** Validate one row against the reader texts: existence + (mech) extraction. */
export function resolveRowDefault(row, texts, constSources = CONST_SOURCES) {
  const src = texts.get(row.read.file);
  if (src === undefined) {
    throw new Error(`row source file is not a reader: ${row.read.file} (${row.path})`);
  }
  const line = src.split("\n")[row.read.line - 1];
  if (line === undefined || !line.includes(row.read.evidence)) {
    throw new Error(
      `existence check failed for ${row.path}: ${row.read.file}:${row.read.line} ` +
        `does not contain ${JSON.stringify(row.read.evidence)}`,
    );
  }
  if (row.mech) {
    const constFile = constSources[row.mech.const];
    if (!constFile) throw new Error(`unmapped defaults constant: ${row.mech.const}`);
    if (!texts.has(constFile)) {
      throw new Error(`defaults constant file is not a reader: ${constFile}`);
    }
    return extractConstDefault(texts.get(constFile), row.mech.const, row.mech.prop);
  }
  return row.default === undefined ? null : row.default;
}

// ── Schema assembly ─────────────────────────────────────────────────────────

function leafNode(row, value) {
  const node = { type: row.type, description: row.description };
  if (value !== null) node.default = value;
  if (row.enum) node.enum = row.enum;
  node["x-source"] = `${row.read.file}:${row.read.line}`;
  return node;
}

/**
 * Build the nested schema tree from validated rows. The `<ext>` segment
 * becomes a patternProperties entry so any extension name accepts the
 * per-tool `enabled` list. Order-independent: a node that is both a leaf
 * (the toggle row) and a parent (tuned-object fields) keeps both roles.
 */
export function buildSchemaTree(validatedRows) {
  const root = {};
  const braid = {
    type: "object",
    description: "Braid settings under the top-level braid key.",
    properties: {},
  };
  root.braid = braid;
  for (const { row, value } of validatedRows) {
    const segments = row.path.split(".");
    segments.shift(); // "braid" — the root node is fixed
    let owner = braid; // node whose .properties holds the children
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i];
      const last = i === segments.length - 1;
      if (seg === "<ext>") {
        owner = wildcard(patternPropertiesOf(owner));
        continue;
      }
      if (last) setLeaf(owner.properties, seg, leafNode(row, value));
      else owner = descend(owner.properties, seg);
    }
  }
  return sortNode(root);
}

function patternPropertiesOf(owner) {
  if (!owner.__patternProperties) {
    owner.__patternProperties = { "^.+$": { type: "object", properties: {} } };
  }
  return owner.__patternProperties;
}

function wildcard(patternProps) {
  return patternProps["^.+$"];
}

/** Child node for an intermediate segment; a leaf gains .properties, not a clobber. */
function descend(siblings, seg) {
  if (!siblings[seg]) siblings[seg] = { type: "object", properties: {} };
  if (!siblings[seg].properties) siblings[seg].properties = {};
  return siblings[seg];
}

/** Leaf placement; an existing subtree keeps its children under the leaf fields. */
function setLeaf(siblings, seg, leaf) {
  const prev = siblings[seg];
  siblings[seg] = prev && prev.properties ? { ...leaf, properties: prev.properties } : leaf;
}

/** Sort keys deeply and strip the internal patternProperties marker. */
function sortNode(node) {
  if (Array.isArray(node)) return node;
  if (node && typeof node === "object") {
    const out = {};
    for (const key of Object.keys(node).sort()) {
      if (key === "__patternProperties") {
        out.patternProperties = {};
        for (const p of Object.keys(node.__patternProperties).sort()) {
          out.patternProperties[p] = sortNode(node.__patternProperties[p]);
        }
        continue;
      }
      out[key] = sortNode(node[key]);
    }
    return out;
  }
  return node;
}

/** Render the full schema document (byte-stable). */
export function renderSchema(tree) {
  const doc = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    title: "braid settings (settings.json → braid.*)",
    description:
      "Derived from the braid.* readers by packages/core/scripts/gen-braid-schema.mjs; regenerate rather than edit by hand.",
    type: "object",
    properties: tree,
  };
  return `${JSON.stringify(doc, null, 2)}\n`;
}

/** Load the reader texts keyed by repo-relative path, failing on a missing file. */
export function loadReaderTexts(readerFiles = READER_FILES, root = REPO_ROOT) {
  const texts = new Map();
  for (const rel of readerFiles) {
    const abs = join(root, rel);
    if (!existsSync(abs)) {
      throw new Error(`reader file missing: ${rel} — add it or remove it from the allowlist`);
    }
    texts.set(rel, readFileSync(abs, "utf8"));
  }
  return texts;
}

/** Full derivation over the reader texts: validate every row, build, render. */
export function generateSchema({ readerFiles = READER_FILES, rows, constSources = CONST_SOURCES } = {}, root = REPO_ROOT) {
  const texts = loadReaderTexts(readerFiles, root);
  const mechanical = rows?.mechanical ?? MECHANICAL_ROWS;
  const overlay = rows?.overlay ?? OVERLAY_ROWS;
  const all = [...mechanical.map((r) => ({ ...r, __kind: "mechanical" })), ...overlay.map((r) => ({ ...r, __kind: "overlay" }))];
  const validated = all.map((row) => ({ row, value: resolveRowDefault(row, texts, constSources), kind: row.__kind }));
  const counts = {
    total: validated.length,
    mechanical: validated.filter((v) => v.kind === "mechanical").length,
    overlay: validated.filter((v) => v.kind === "overlay").length,
  };
  return { text: renderSchema(buildSchemaTree(validated)), counts };
}

// ── CLI ─────────────────────────────────────────────────────────────────────

function main() {
  const artifactPath = join(REPO_ROOT, "packages/core/schema/braid.schema.json");
  const { text, counts } = generateSchema();
  mkdirSync(dirname(artifactPath), { recursive: true });
  writeFileSync(artifactPath, text, "utf8");
  console.log(
    `braid.* schema: ${counts.total} keys (${counts.mechanical} mechanical, ${counts.overlay} overlay) → packages/core/schema/braid.schema.json`,
  );
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  try {
    main();
  } catch (e) {
    console.error(`gen-braid-schema: ${e.message}`);
    process.exit(1);
  }
}
