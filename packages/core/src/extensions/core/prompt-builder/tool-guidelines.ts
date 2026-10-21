/**
 * Per-tool guideline sync — OWNERSHIP-INVERTED.
 *
 * The per-tool line rendered in the braid "Available tools:" inventory comes
 * from, in priority order (see index.ts toolsSection):
 *
 *   1. `tool.promptGuidelines[0]` — the tool's OWNING package declares it in
 *      its `pi.registerTool({ ..., promptGuidelines })` registration
 *      (verified native seam: registerTool stores the raw definition,
 *      getAllTools() exposes promptGuidelines). No braid-core reference.
 *      EXCEPTION: the five pinned pi-core builtins (PINNED_BUILTIN_OVERRIDES:
 *      read/bash/edit/write/powershell) DO self-register promptGuidelines,
 *      but their self-registered lines are thinner than braid's curated
 *      rows; for those five, priority 2 wins.
 *   2. `TOOL_GUIDELINES[name]` — THIS static record: braid-owned tools
 *      (registered by this package) and pi-core builtins (pinned dependency,
 *      curated here). Source of truth: packages/core/TOOLS.md; the
 *      lockstep block in test/runtime/core/test-tool-pipelines.mjs enforces
 *      exact one-to-one equality (same tool set, same strings).
 *   3. `EXTERNAL_TOOL_GUIDELINES[name]` — last-resort map for unowned
 *      third-party tools we cannot patch (herdr, fetch_content). See
 *      external-tool-guidelines.ts. Owners MUST self-register instead; this
 *      map is the documented exception, not the pattern.
 *   4. NO ROW. A tool with no owned guideline renders no row: its
 *      registered description rides the same request via the API tools
 *      channel, and a first-sentence row would only restate it. The
 *      renderer's entry is `resolveOwnedToolLine` (priorities 1-3); the
 *      fallback survives in `resolveToolLine` for other callers.
 *
 * STYLE CONTRACT (grounded in OpenAI/Anthropic
 * tool-use guidance): the line carries STRATEGY ONLY — when / when-not /
 * key-args (formats) / caveat. The "what it does" is owned by the tool's
 * registration description (rendered through the API tools channel); the
 * guideline must NOT restate it. Intern test: a fresh agent must be able to
 * call the tool correctly, with the right arguments, from this line alone
 * (plus the description). No `|`, no newlines (table sync constraints).
 * TOOLS.md catalog mirrors every string 1:1 (sync test below).
 *
 * Gating contract: injection is per-tool — a tool's line renders ONLY when
 * that tool is active in the current prompt (`if has <tool>`). Tool profiles
 * (set_tool_profile) reduce the active set, so reduced profiles render fewer
 * lines automatically.
 */

import { EXTERNAL_TOOL_GUIDELINES } from "./external-tool-guidelines.js";

/**
 * tool name -> guideline. Order is the render order: pi-native core tools
 * first, then braid tools in manifest order.
 */
export const TOOL_GUIDELINES: Record<string, string> = {
  // ── pi-native core tools (curated; the owning pi-core package
  //    self-registers thinner promptGuidelines — PINNED_BUILTIN_OVERRIDES
  //    makes these rows win) ──
  read: "when: ground truth for anything on disk, incl. images as attachments, instead of cat or sed; when-not: content search (grep/find); args: path, offset for long files; caveat: text truncated at 2000 lines / 50KB",
  bash: "when: tests, builds, git, shell pipelines, or inspecting PI-prefixed env vars for model/session details — anything without a dedicated tool; when-not: file read/edit; args: command + timeout; caveat: output truncated to 2000 lines / 50KB",
  edit: "when: one precise change to a known file; when-not: new files (write) or whole-file overhauls; args: oldText must match a UNIQUE region exactly; caveat: multiple edits in one call must not overlap",
  write:
    "when: create or overwrite a whole file; when-not: small tweaks to an existing file (edit); args: path + full content; caveat: truncates in place; a failed write can leave a partial file",
  grep: "when: find where a symbol/string lives (file:line); when-not: full file contents (read); args: pattern + optional glob/path; caveat: respects .gitignore, 100-match / 50KB cap, long lines cut at 500 chars",
  find: "when: locate files by name or glob without shelling out; when-not: content search (grep); args: glob pattern + optional path; caveat: respects .gitignore",
  ls: "when: see what is actually in a directory before reading or running; args: path + limit; caveat: includes dotfiles, '/' suffix marks directories",
  powershell:
    "when: PowerShell-only commands, or inspecting PI-prefixed env vars for model/session details; when-not: POSIX shells (bash); args: command + timeout; caveat: same truncation rules as bash",
  tool_search:
    "when: a tool you expected is missing from this list (braid defers its cold tools; this is how they come back); args: query + limit; caveat: matches are declared from your NEXT call, so load first, then call",

  // ── metacognition (alwaysOn) ──
  think:
    "when: high-stakes or hard-to-reverse decisions; args: decision + observation/reason/confidence",
  hypothesize:
    "when: a first fix attempt failed and the root cause is unclear; args: problem + evidence; caveat: name a specific, verifiable failure mode — never vague",
  finalize:
    "when: task fully done and verified; when-not: unresolved verify() (it blocks); args: summary + completed (+ tasksRemaining); caveat: call once per task, then text only",
  verify:
    "when: after every edit, or any uncertain conclusion; when-not: finalizing before verification; args: target (code/reasoning/plan/result) + explicit criteria; caveat: name the failure mode each check guards",
  verify_claim:
    "when: a conclusion depends on retrieved evidence; when-not: local code checks (verify); args: claim + context strings; caveat: action=decomposition for task-coverage checks",

  // ── scratchpad (alwaysOn) ──
  scratchpad:
    "when: multi-step tasks — keep the resumable state here, it survives compaction; args: action (set_goal/add_plan/mark_done/…) + text",

  // ── prompt-builder (alwaysOn) ──
  prompt_inspect:
    "when: your own instructions feel ambiguous or prompt questions arise; args: match/truncate to filter long sections; caveat: shows the ASSEMBLED prompt",
  system_info: "when: context or environment matters; args: detail=compact for essentials",

  // ── workspace-snapshot (alwaysOn) ──
  workspace_snapshot:
    "when: before risky multi-file edits — capture, then restore on failure; args: action capture/restore; caveat: restore applies only changed files",

  // ── context-management (alwaysOn) ──
  set_tool_profile:
    "when: task scope is known — focused profiles cut prompt noise and token cost; args: lean/research/debugging/browser/deep",

  // ── skills-tool (default-enabled) ──
  list_skills:
    "when: entering a domain that may have a skill; when-not: after the skill is loaded; args: page/pageSize+sectionsMax; caveat: reach (reachable, lines, bytes, chars, estTokens, sectionCount, sections) prices the read — read the WHOLE SKILL.md before acting in the domain",
  skill_stats:
    "when: measure skill adoption — suggested vs loaded counters; args: none; caveat: session + all-time counters (durable, skills-usage.json)",

  // ── topic-drift (default-enabled) ──
  topic_drift:
    "when: multi-part requests — check output against the original ask before responding; args: action check + output; caveat: reset re-anchors the topic",

  // ── timer (default-enabled) ──
  timer:
    "when: non-blocking reminders between turns (babysit cadences, follow-ups); args: delay_seconds + reason; caveat: session-scoped; recurring via interval_seconds+count",

  // ── orchestrator (default-enabled) ──
  orchestrate:
    "when: parallel workers share a tree — declare their files so edits don't collide; args: action register-worker/spawn-worker/check-worker/update-worker/list-workers/close-worker/verify-and-merge + files",

  // ── latent-activator (default-enabled) ──
  behavior:
    "when: swap problem-solving modes to suit the task type (debugger/reviewer/explorer…); args: activate/deactivate/mix + behavior or scenario",

  // ── memory-agent-bridge (default-enabled) ──
  memory_store:
    "when: after fixes, conventions, root-cause findings — persist cross-session; when-not: session-local facts (scratchpad); args: content + memoryType; caveat: tags + importance shape recall",
  memory:
    "when: before non-trivial work — build on known context; args: action recall_search / episodes_search / heuristics_list + query",
  explore_paths:
    "when: debugging with a named failure-mode hypothesis; args: hypothesis_1/2/3, each 'file because reason'; caveat: local search — no sub-agent",
  conflict_qa:
    "when: sources or beliefs contradict; args: action resolve + verdict; caveat: evidence-pool based, reports classification",

  // ── session-recall (default-enabled) ──
  session:
    "when: prior-work context needed across sessions (search/query/analyze/stats); args: action + query/sessionPath; caveat: project-scoped by default",

  // ── error-tracking (opt-in) ──
  error:
    "when: a tool or extension failed and you need the captured error history; args: action list/get/clear/stats",

  // ── health-maintenance (opt-in) ──
  session_health:
    "when: provider errors / auth / balance events occurred; args: action get/diagnose/recover; caveat: recover only after the user acted",
  health_maintenance:
    "when: agent self-state hygiene (check/commit/rollback/benchmark); args: action; caveat: rollback needs a checkpoint hash",
};

/**
 * Resolve the per-tool inventory line by ownership priority:
 *   1. promptGuidelines[0] — the tool's OWNING package (its registration),
 *   2. TOOL_GUIDELINES[name] — braid-owned + pi builtins (TOOLS.md sync),
 *   3. EXTERNAL_TOOL_GUIDELINES[name] — last-resort map, unpatched third-party,
 *   4. first sentence of the tool's own description (unknown/context_* family).
 * Returns undefined when nothing is available (caller skips the line).
 */
export function resolveToolLine(
  name: string,
  description: string | undefined,
  promptGuidelines?: readonly string[],
): string | undefined {
  const owned = Array.isArray(promptGuidelines) ? promptGuidelines[0] : undefined;
  if (typeof owned === "string" && owned.trim()) return owned.trim();
  const staticLine = TOOL_GUIDELINES[name];
  if (staticLine) return staticLine;
  const external = EXTERNAL_TOOL_GUIDELINES[name];
  if (external) return external;
  return description ? firstSentence(description) : undefined;
}

/**
 * pi-core builtins whose rows braid curates: their owning package is a
 * pinned dependency whose self-registered promptGuidelines are thinner than
 * braid's when/when-not/args/caveat rows, so the
 * curated record wins for these names only. Every other tool keeps the
 * ownership-inversion priority: its owning package's registration outranks
 * this record.
 */
const PINNED_BUILTIN_OVERRIDES = new Set(["read", "bash", "edit", "write", "powershell"]);

/**
 * Owned-line resolution for the tools section: like resolveToolLine but
 * stops after priority 3 — no description fallback — and the five pinned
 * pi-core builtins resolve TOOL_GUIDELINES before their owning package's
 * self-registered promptGuidelines (see PINNED_BUILTIN_OVERRIDES). A tool
 * with no owned guideline (promptGuidelines / TOOL_GUIDELINES / EXTERNAL
 * map) renders no row: its registered description rides the same request via
 * the API tools channel, so a first-sentence one-liner would only restate it.
 * Returns undefined for such tools; the caller skips the row.
 */
export function resolveOwnedToolLine(
  name: string,
  promptGuidelines?: readonly string[],
): string | undefined {
  if (PINNED_BUILTIN_OVERRIDES.has(name)) {
    const curated = TOOL_GUIDELINES[name] ?? EXTERNAL_TOOL_GUIDELINES[name];
    if (curated) return curated;
  }
  const owned = Array.isArray(promptGuidelines) ? promptGuidelines[0] : undefined;
  if (typeof owned === "string" && owned.trim()) return owned.trim();
  return TOOL_GUIDELINES[name] ?? EXTERNAL_TOOL_GUIDELINES[name];
}

/** First sentence of a tool description ("what it does" — description-side
 *  contract, mirrors the fallback contract of the tools section). */
export function firstSentence(text: string): string {
  const match = text.match(/^([^.!?\n]*[.!?])\s?/);
  if (match) {
    const s = match[1].trim();
    return s.length <= 120 ? s : s.slice(0, 117) + "...";
  }
  const line = text.split("\n").find((l) => l.trim().length > 0);
  const t = (line ?? text).trim();
  return t.length <= 120 ? t : t.slice(0, 117) + "...";
}

/**
 * Render the per-tool guideline lines for the tools present in the current
 * active set. Emits exactly one `- <name>: <reflection>` line per present
 * tool, in TOOL_GUIDELINES order; unknown tools are skipped (the caller
 * applies its own fallback priority). Returns [] when no documented tool is
 * active.
 */
export function perToolGuidelines(toolNames: readonly string[]): string[] {
  const present = new Set(toolNames);
  const out: string[] = [];
  for (const name of Object.keys(TOOL_GUIDELINES)) {
    if (present.has(name)) out.push(`- ${name}: ${TOOL_GUIDELINES[name]}`);
  }
  return out;
}
