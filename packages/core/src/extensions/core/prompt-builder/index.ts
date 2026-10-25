import { deliverPastInsights } from "../../../lib/memory/past-insights.js";
import { getCognitiveMemory } from "../../../lib/memory/index.js";
import {
  registerSessionStartHandler,
  SessionPhase,
} from "../../../lib/state/session-start-queue.js";
import { getAgentDir, loadProjectContextFiles } from "@earendil-works/pi-coding-agent";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { RESOURCES_DISCOVER, AGENT_SETTLED } from "../../../lib/core/event-names.js";
import { gatherContextState, contextSection } from "./context-section.js";
import { deliverActiveSpecs } from "../../../lib/cognitive/openspec.js";
import { deliverRelevantHints } from "../../../lib/cognitive/hints.js";
import { deliverAwarenessWhisper, type AwarenessCounts } from "./awareness-whisper.js";
import { getContextUsage } from "../../../lib/detection/context-tiers.js";
import { readTelegramPollerLiveness } from "../../../lib/state/telegram-poller-liveness.js";
import type { PromptSection } from "./section.js";
import { linesSection, simpleSection, composeSections, composeSectionMap } from "./section.js";
import { piReferenceSection } from "./pi-reference-section.js";
import { customSectionsFrom } from "./custom-sections.js";
import { publishPromptSections } from "./section-publish.js";
import { toolPipelineLines } from "./tool-pipelines.js";
import { TOOL_GUIDELINES, resolveOwnedToolLine } from "./tool-guidelines.js";
import {
  IDENTITY_INTRO,
  DISCOVERY,
  WORK_ETHIC,
  REPAIR_DISCIPLINE,
  SELF_MANAGEMENT,
  COMMUNICATION,
  EPISTEMIC_STANCE,
  SELF_AUDIT,
  PHILOSOPHY,
} from "./identity.js";
import { surfaceDisciplineSection } from "./surface-discipline-section.js";
import { skillsLoadingText } from "../skills-tool/loading-guidance.js";
import {
  reconstructProjectDocsSection,
  resetProjectDocsSectionCache,
} from "./project-docs-section.js";
import { setCachedSkills } from "../skills-tool/index.js";
import { getCachedVisibleSkills } from "../skills-tool/auto-inject.js";
import { reconstructMemorySection, resetMemorySectionCache } from "./memory-section.js";
import { gatherInstanceData, renderCompactInstance } from "./instance-composition.js";
import { sendTrackedMessage } from "../../../lib/utils/injection-tracker.js";
import { formatLocalTime } from "../../../lib/utils/local-time.js";
import { flushRecoveredFires } from "../../../extensions/scheduling/timer/wake-retry.js";
// Persisted-timer recovery lives in the timer module: the owning-session
// invariant is the shared store's, not this caller's. This file only wires
// the sweep into the turn start and re-exports the surface for the tests.
import {
  recoverPersistedTimers,
  dedupPersistedTimers,
  hasLiveEquivalent,
} from "../../../extensions/scheduling/timer/recovery.js";
import { createLogger } from "../../../lib/core/logger.js";

const log = createLogger("prompt-builder/timer");

/** Datetime drift-guard window: re-anchor the agent's clock after 30 minutes. */
export const DATETIME_REFRESH_INTERVAL_MS = 30 * 60 * 1000;

/**
 * Datetime drift-guard decision (pure; exported for the fixture test).
 *
 *   anchorAt === 0  -> session start not observed yet: the system prompt's
 *                     own datetime stamp IS the first anchor (no whisper).
 *   age >= 30 min   -> inject + re-anchor (the re-anchor IS the rate limit:
 *                      exactly one refresh per 30-min window).
 *   age <  30 min   -> skip.
 *
 * Returns the new anchor (0 means "set anchor silently, no whisper").
 */
export function datetimeRefreshDecision(
  anchorAt: number,
  nowMs: number,
): { inject: boolean; newAnchor: number } {
  if (anchorAt === 0) return { inject: false, newAnchor: nowMs };
  if (nowMs - anchorAt >= DATETIME_REFRESH_INTERVAL_MS) {
    return { inject: true, newAnchor: nowMs };
  }
  return { inject: false, newAnchor: anchorAt };
}

/**
 * Prompt Builder - Reconstruction from Structured Data
 *
 * No fragile string extraction. Everything built from APIs and fixed templates.
 * Only pi-braid additions (identity framings, discovery stance, tool
 * pipelines, guidelines) are custom.
 *
 * Sections built from structured data:
 * - Tools: pi.getAllTools() (with promptSnippet)
 * - Skills: counts + base dirs from event.systemPromptOptions.skills (the
 *   fully resolved list pi built via its package manager -- includes user,
 *   project, AND package skills). The catalog itself is not rendered in the
 *   prompt: the list_skills tool serves it on demand (setCachedSkills).
 *   The once-per-session awareness whisper carries context token counts,
 *   not skill counts.
 *   Canonical pattern from pi's own docs: extensions should not re-discover
 *   skills; they should reformat what pi already loaded.
 * - Project docs: reconstructProjectDocsSection() renders AGENTS.md /
 *   CLAUDE.md files from loadProjectContextFiles() as plain-text pointer
 *   lines (`- <basename> at <path>`, no XML wrapper -- pointer-only, agent
 *   reads full content on demand). Mirrors the skills model. Prevents
 *   pattern-matching against stale doc references.
 * - pi docs pointer: a static pointer to the pi-reference skill
 *   (pi-reference-section.ts); the skill owns pi's docs index, so the prompt
 *   does not re-send the path list.
 * - Guidelines: fixed template based on tool availability
 * - Instance line: version, cwd, session — computed directly
 *
 * Sections re-implemented locally:
 * - Identity: Braid agent identity (smart-mix: persona + native pattern +
 *   generalist; the framings exported by identity.ts: identity blocks,
 *   skills-loading directive, discovery stance)
 * - L1 environmental state (session stats, context usage, session health)
 *
 * Design stance: identity framing beats explicit directives; no
 * latent-behavior activation in the prompt (latent activation runs at
 * runtime via `latent-activator`).
 *
 * Publication: the stable group is published as `customPrompt` (pi renders it
 * as the untagged preamble and suppresses its native preamble, tools, rules,
 * and docs) and the turn-to-turn text as named `sections` entries that pi diffs
 * against the transcript individually. See section-publish.ts.
 */

import { getExtensionState, getSessionIdSafe } from "../../../lib/state/extension-state.js";

interface PromptBuilderState {
  insightsSent: boolean;
  /**
   * Fresh clock: epoch ms of the last
   * datetime anchor the agent saw. 0 = session start not yet observed (the
   * system prompt stamps the datetime once at session start — that stamp is
   * the first anchor). The drift guard injects a one-line datetime whisper
   * when >30 min have passed since the last anchor (rate-limited to
   * once/30min by construction — each injection re-anchors).
   */
  lastDatetimeAnchorAt: number;
}

function getPromptState(ctx: ExtensionContext): PromptBuilderState {
  return getExtensionState(ctx, "prompt-builder", () => ({
    insightsSent: false,
    lastDatetimeAnchorAt: 0,
  }));
}
/**
 * Extract the first sentence of a description for the tool listing.
 *
 * Used only for tools WITHOUT a TOOL_GUIDELINES reflection (contrib / npm
 * tools). Documented tools render their reflection directly in the tools
 * section.
 *
 * Tool descriptions should be written so the first sentence contains both
 * "what it does" and "when to use" — this extracts that first sentence cleanly.
 */
// Guidelines render before tools (pi-core native pattern): Identity →
// Guidelines → Discovery/Pipelines → Tools → Context → Instance.

/**
 * File tool guidelines: bash/grep/find/ls usage (pi-core native pattern).
 * Conditional on tool availability — only shows if bash is present.
 */
function fileToolGuidelines(toolNames: string[]): string[] {
  const lines: string[] = [];
  const hasBash = toolNames.includes("bash");
  const hasGrep = toolNames.includes("grep");
  const hasFind = toolNames.includes("find");
  const hasLs = toolNames.includes("ls");
  if (hasBash && !hasGrep && !hasFind && !hasLs) {
    lines.push("Use bash for file operations like ls, rg, find");
  } else if (hasBash && (hasGrep || hasFind || hasLs)) {
    lines.push(
      "Prefer grep/find/ls tools over bash for file exploration (faster, respects .gitignore)",
    );
  }
  return lines;
}

/**
 * Communication guidelines: pi-native directives, guarded by tool availability.
 *
 * "Show file paths" is guarded by read/bash presence — no point telling the
 * agent to show file paths if it can't access files to begin with.
 *
 * Research backing: Bakhshi (2026) arXiv:2604.19768 - LLMs exhibit systematic
 * epistemic-rhetorical patterns at ~2x human rate
 */
function communicationGuidelines(toolNames: string[]): string[] {
  const lines: string[] = [
    "Write text that reads naturally, as if written by a human, not generated by a machine",
  ];
  const hasRead = toolNames.includes("read");
  const hasBash = toolNames.includes("bash");
  if (hasRead || hasBash) {
    lines.push("Show file paths clearly when working with files");
  }
  return lines;
}

/**
 * Context navigation pipeline guidelines (tool-availability-guarded).
 *
 * Teaches the agent the session-tree mental model and the archival stance —
 * the two policy sentences. Tool mechanics stay in tool descriptions (dedup
 * with the tools channel).
 *
 * Concise: no markdown headings, no excessive structure.
 */
function contextNavigationGuidelines(toolNames: string[]): string[] {
  const lines: string[] = [];
  const hasContextNavigate = toolNames.includes("context_navigate");
  const hasContextCompress = toolNames.includes("context_compress");

  if (!hasContextNavigate && !hasContextCompress) {
    return lines;
  }

  lines.push("");

  if (hasContextNavigate) {
    lines.push(
      "The session is a branching tree \u2014 tag positions, log to see history, checkout to jump to a leaf with its context summarized. Use backupTag to save your spot before jumping.",
    );
  }

  if (hasContextCompress) {
    // Generic pipeline stance: thresholds live
    // in one place only — the extension ladder (context-thresholds.ts,
    // enforced by context-lifecycle advisories). The prompt carries the
    // stance, not a second copy of the numbers.
    lines.push(
      "Context is finite: tag positions before archival, archive old ranges deliberately, inspect health often; obey context-lifecycle advisories.",
    );
  }

  return lines;
}

/**
 * Assemble all guidelines into a single section, placed before tools.
 * Order: file tools → communication → context navigation.
 * Each family is a clear sub-structure for easy maintainability.
 *
 * Per-tool instructions render once, in the TOOLS section, from
 * TOOL_GUIDELINES (synced with TOOLS.md). This section keeps only
 * cross-tool habits.
 */
function guidelinesSection(toolNames: string[]): PromptSection {
  const allLines = [
    ...fileToolGuidelines(toolNames),
    ...communicationGuidelines(toolNames),
    ...contextNavigationGuidelines(toolNames),
  ];
  return linesSection("guidelines", allLines, { dedup: true });
}

function toolsSection(tools: ReturnType<ExtensionAPI["getAllTools"]>): PromptSection {
  // One line per tool — single rendering. Per-tool line priority
  //  (ownership inversion): the tool's OWNING package declares its
  // guideline via `promptGuidelines` in its own registration (native seam:
  // registerTool stores the raw definition, getAllTools exposes it) → else
  // TOOL_GUIDELINES (braid-owned + pi builtins, synced 1:1 with TOOLS.md) →
  // else EXTERNAL_TOOL_GUIDELINES (last-resort map for unpatched third-party
  // packages) → else NO ROW. Exception: the five pinned builtins
  // (read/bash/edit/write/powershell) render TOOL_GUIDELINES over their
  // owners' thinner self-registered lines — see PINNED_BUILTIN_OVERRIDES in
  // tool-guidelines.ts. Descriptions live in the API tools channel; the
  // guideline never restates them.
  const visibleTools = tools
    .filter((t) => t.name && (t.description || TOOL_GUIDELINES[t.name]))
    .map((t) => {
      // The runtime exposes promptGuidelines on tool objects though the
      // shipped pi-ai type omits it — widen locally.
      const line = resolveOwnedToolLine(
        t.name,
        (t as { promptGuidelines?: unknown }).promptGuidelines as string[] | undefined,
      );
      return line ? `- ${t.name}: ${line}` : null;
    })
    .filter((line): line is string => line !== null)
    .join("\n");

  return {
    name: "tools",
    render: () => {
      return `Available tools:\n${visibleTools || "(none)"}\n\nOther custom tools may exist depending on the project.`;
    },
  };
}

/**
 * The identity seat join, exported as a pure function: the handler's REAL
 * section list for the main identity block. The structural pin test imports
 * this from the built handler, so its seat/verbatim assertions exercise the
 * production composition instead of a hand-mirror. No behavior change: the
 * handler below builds the identical simpleSection through this function.
 */
export function identitySection(): PromptSection {
  return simpleSection(
    "identity",
    [IDENTITY_INTRO, WORK_ETHIC, REPAIR_DISCIPLINE, SELF_MANAGEMENT, COMMUNICATION].join("\n\n"),
  );
}

async function projectContextSection(cwd: string, ctx: ExtensionContext): Promise<PromptSection> {
  // Uses pi-core's exported `loadProjectContextFiles` — the canonical
  // resolution order: agent-dir global context, then cwd-ancestors
  // (most-root last), deduped by path.
  //
  // Pointer-only model: we DO NOT inject AGENTS.md / CLAUDE.md content
  // into the system prompt. Instead we render plain-text pointer lines
  // (`- <basename> at <path>`) listing the files, and let the agent `read`
  // the full content on demand. This mirrors the skills model and prevents
  // the agent from pattern-matching against stale doc references when
  // parsing ambiguous external output.

  // loadProjectContextFiles is sync, so wrap the call in a microtask
  // so the function remains `async` (matches PromptSection contract).
  const contextFiles = await Promise.resolve().then(() =>
    loadProjectContextFiles({ cwd, agentDir: getAgentDir() }),
  );

  return {
    name: "project-docs",
    render: async () => reconstructProjectDocsSection(contextFiles, ctx),
  };
}

import { createPromptInspectTool } from "./inspect.js";
import { createSystemInfoTool } from "./system-info-tool.js";
import { trimProviderTools } from "./tool-description-trim.js";

export default function promptBuilderExtension(pi: ExtensionAPI) {
  pi.registerTool(createPromptInspectTool());
  pi.registerTool(createSystemInfoTool(pi));
  // Fallback flush for recovered persisted fires. The timer extension's
  // agent_settled handler is the primary flush point; this listener keeps the
  // deferral correct even if the timer extension is disabled. Both are safe
  // to run twice: takeRecoveredFires() drains (second call sees an empty
  // queue) and onAgentSettled() is idempotent.
  pi.on(AGENT_SETTLED, () => flushRecoveredFires(pi));
  // Third-party tool-description trim: the
  // provider payload tools channel — the only official interception point
  // for registered descriptions (mechanism note in tool-description-trim.ts).
  // Returns undefined when nothing changed (runner keeps the payload).
  pi.on("before_provider_request", (event) => trimProviderTools(event.payload));

  // Context: tools, skills, memories, runtime extensions, project docs, memory
  // Fetched once per session, cached afterwards (session-scoped state).
  // Uses registerSessionStartHandler so the state is available before the
  // first prompt is built.
  registerSessionStartHandler(pi, SessionPhase.MemoryState, async (_event, ctx) => {
    // getPromptState() lazily initializes the state entry; the result is
    // intentionally unused here (no enforcement_signals listener).
    const _ps = getPromptState(ctx);
  });

  // resources_discover: invalidate skills, project-docs, memory caches
  // When resources are re-discovered (e.g. /reload, or session replacement),
  // pi re-resolves skills and project context. We invalidate our format
  // caches so the next before_agent_start renders with the new sets. The
  // memory section also invalidates so a freshly-written episode surfaces
  // in the next turn's pointer block.
  pi.on(RESOURCES_DISCOVER, async (_event, ctx) => {
    resetProjectDocsSectionCache(ctx);
    resetMemorySectionCache(ctx);
  });

  pi.on("before_agent_start", async (event, ctx) => {
    // Fire any persisted timers that expired during a process gap (e.g. /reload).
    // Owning-session scoped: the store is shared per project CWD, so recovery
    // must never deliver another session's records into this process.
    recoverPersistedTimers(pi, getSessionIdSafe(ctx));

    const ps = getPromptState(ctx);
    const cwd = ctx.cwd;
    const allTools = pi.getAllTools();
    const activeToolNames = pi.getActiveTools() ?? allTools.map((t) => t.name);
    const tools =
      activeToolNames.length > 0
        ? allTools.filter((t) => activeToolNames.includes(t.name))
        : allTools;
    const toolNames = tools.map((t) => t.name);
    const hasRead = toolNames.includes("read");
    const hasListSkills = toolNames.includes("list_skills");

    // Fresh clock: 30-min datetime drift guard. The system prompt stamps
    // the datetime once at session start; long sessions run on a stale
    // clock. See datetimeRefreshDecision() for the exact contract.
    const nowMs = Date.now();
    const refresh = datetimeRefreshDecision(ps.lastDatetimeAnchorAt, nowMs);
    ps.lastDatetimeAnchorAt = refresh.newAnchor;
    if (refresh.inject) {
      try {
        sendTrackedMessage(
          pi,
          {
            customType: "datetime-refresh",
            display: true,
            content: [
              {
                type: "text" as const,
                text: `Datetime refresh: ${formatLocalTime(new Date(), true)} — mid-session clock anchor (last anchor >30 min ago).`,
              },
            ],
          },
          { delivery: "park", deliverAs: "steer" },
          { type: "context", source: "prompt-builder/datetime" },
        );
      } catch (err) {
        log.debug(`datetime drift-guard whisper failed (non-fatal): ${String(err)}`);
      }
    }

    const contextData = await gatherContextState(pi, ctx);
    const context = contextSection(contextData);

    // Live resource counts (skills / memories), computed once so the
    // instance line reports the same values.
    const skills = event.systemPromptOptions?.skills ?? [];
    // Cache skills for the list_skills tool (on-demand discovery).
    setCachedSkills(skills);
    // Extract unique base directories from loaded skill file paths so the
    // Instance block can show where skills are loaded from (not just the count).
    const skillDirs = [...new Set(skills.map((s) => s.baseDir).filter(Boolean))];
    let memoryCount = 0;
    try {
      const memory = getCognitiveMemory();
      try {
        await memory.init();
      } catch {
        /* already init'd or non-fatal */
      }
      // getAll(limit) slices the in-memory store, so a small limit turned the
      // rendered memory count into a floor of 3. The instance line reports a
      // true count: ask for the whole store.
      memoryCount = memory.getAll(Number.MAX_SAFE_INTEGER).length;
    } catch {
      /* memory unavailable - non-fatal */
    }

    // 5. Supplemental context (past insights, hints, OpenSpec specs,
    //    awareness) -> offloaded to steer whispers (once per session).
    //    Avoids per-turn disk I/O and system prompt bloat for context the
    //    agent can re-load via `read` if needed.
    if (!ps.insightsSent) {
      // Claim the slot synchronously, before the first await below: two prompt
      // builds that overlap would otherwise both read the flag unset while the
      // deliveries are in flight, and every once-per-session whisper goes out
      // twice. The claim is one read-and-write with no await between, so a
      // second build either sees the claim or arrives after the deliveries
      // settled - the window is closed, not narrowed.
      ps.insightsSent = true;
      // Once-per-session context-hygiene whisper: the awareness catalog's
      // live token-delta signal — tokens in context + tokens added since
      // the previous emission's baseline. Usage comes from the same
      // duck-typed accessor context-section.ts uses (getContextUsage); the
      // since-baseline delta is tracked inside the whisper module. The TG
      // row is gated by the poller liveness registry
      // (lib/state/telegram-poller-liveness.ts): running → live,
      // stopped/absent-probe → hedged row.
      const usage = getContextUsage(ctx);
      const pollerLiveness = readTelegramPollerLiveness();
      const awarenessCounts: AwarenessCounts = {
        tokensInContext: usage?.tokens ?? 0,
        contextToolCount: pi.getAllTools().filter((t) => t.name.startsWith("context_")).length,
        telegramInbound:
          pollerLiveness === "running" ? "live" : pollerLiveness === "stopped" ? "off" : "unknown",
      };
      // Run in parallel - each delivery is independent and best-effort.
      // allSettled ensures one failure doesn't block the others.
      await Promise.allSettled([
        deliverPastInsights(cwd, pi, ctx),
        deliverRelevantHints(cwd, pi, ctx),
        deliverActiveSpecs(cwd, pi, ctx),
        deliverAwarenessWhisper(pi, ctx, awarenessCounts),
      ]);
    }

    // Build the prompt as a flat list of sections. Every section is a
    // `PromptSection`; the top-level handler never touches raw strings
    // or arrays of strings.
    // Instance: compact one-line orientation (build + install root, model,
    // PID, session, resource counts); full data stays in the system_info
    // tool. The block carries process-stable facts only: the system prompt
    // is a cached prefix, so a field that changes between turns (a clock,
    // elapsed time, turn or tool counters, context size) would invalidate
    // that prefix on every request and cost more than the field is worth.
    const instanceData = await gatherInstanceData(pi, ctx, {
      skillCount: skills.length,
      skillDirs,
      skills: skills.map((s) => ({
        name: s.name,
        filePath: s.filePath,
        baseDir: s.baseDir,
      })),
      memoryCount,
    });
    const compactInstanceLine = renderCompactInstance(instanceData);
    // Discovery & exploration stance. Guarded by tool availability: each
    // line only appears when its tools exist; the stance paragraph is
    // unconditional. Placed after guidelines, before tools — a stance, not
    // a tool inventory.
    const discoveryLines = DISCOVERY.filter(
      (line) => line.guard.length === 0 || line.guard.some((t) => toolNames.includes(t)),
    ).map((line) => line.text);

    // Tool-usage pipelines. Guarded multi-tool sequences per task domain;
    // every pipeline renders only when all its guard tools are active (tool
    // profiles can reduce the active set). Section skipped entirely when
    // nothing qualifies.
    const pipelineLines = toolPipelineLines(toolNames);

    const stableSections: PromptSection[] = [
      // 1. Identity: three seats — the main block, the surface-discipline
      //    block (its own section file), and the identity-core block.
      //    Rendered order: COMMUNICATION → SURFACE_DISCIPLINE →
      //    EPISTEMIC_STANCE.
      identitySection(),
      surfaceDisciplineSection(),
      simpleSection("identity-core", [EPISTEMIC_STANCE, SELF_AUDIT, PHILOSOPHY].join("\n\n")),

      // 2. Skills floor (before guidelines, before tools).
      //    Owned by the skills-tool module (loading-guidance.ts) and rendered
      //    here: the visible catalog itself, one row per skill, plus the
      //    read rule and the mechanical trigger. Guarded by read AND
      //    list_skills availability — the rule instructs a full-file read and
      //    the trigger names the catalog, so both tools must be present. The
      //    rows and the read root come from the live cache (setCachedSkills
      //    above); an empty catalog renders no section at all.
      ...(hasRead && hasListSkills
        ? [simpleSection("skills-loading", skillsLoadingText(toolNames, getCachedVisibleSkills()))]
        : []),

      // 3. Guidelines (before tools, pi-core native pattern).
      //    Order: file tools → communication → context navigation.
      guidelinesSection(toolNames),

      // 4. Discovery & exploration stance (after guidelines, before tools).
      ...(discoveryLines.length > 0
        ? [simpleSection("discovery", discoveryLines.join("\n\n"))]
        : []),

      // 5. Tool-usage pipelines (after discovery, before resources/tools).
      //      Per-domain sequences: when to use, the order, the closing outcome.
      //      Context management is intentionally absent — already covered by
      //      contextNavigationGuidelines above (dedup contract).
      ...(pipelineLines.length > 0 ? [simpleSection("pipelines", pipelineLines.join("\n\n"))] : []),
    ];

    // Available tools, then the pi docs pointer (the pi-reference skill
    //    owns pi's docs index; see pi-reference-section.ts).
    stableSections.push(toolsSection(tools));
    stableSections.push(piReferenceSection());

    // Unified context block (project-docs + memory + runtime context).
    //    No heading — plain text, like the rest of the prompt.
    const contextFragments = [
      ...(hasRead ? [await (await projectContextSection(cwd, ctx)).render()] : []),
      ...(hasRead ? [await reconstructMemorySection(ctx)] : []),
      await context.render(),
    ].filter((s) => s && s.trim() !== "");
    const contextBlock = contextFragments.join("\n\n");

    // Instance last: environment orientation is final — the agent reads
    // top-down, and the top region carries identity and guidance. Full
    // environment data remains in the system_info tool. Both this and the
    // context block are published as named sections, so a changed line
    // re-sends that section instead of the whole prompt.

    // Caller-supplied sections (SDK hosts) and appendSystemPrompt from
    //     pi-native. Both preserve outside content; both ride the dedup set,
    //     so content matching a section above is silently dropped. Read here,
    //     before publishPromptSections replaces the options map with braid's
    //     own sections.
    stableSections.push(...customSectionsFrom(event.systemPromptOptions));
    const appendPrompt = event.systemPromptOptions?.appendSystemPrompt;
    if (appendPrompt) {
      stableSections.push(simpleSection("append", appendPrompt));
    }

    const dedupSet = new Set<string>();
    const stablePrompt = await composeSections(stableSections, "\n\n", dedupSet);
    const volatileSections = await composeSectionMap(
      [simpleSection("context", contextBlock), simpleSection("instance", compactInstanceLine)],
      dedupSet,
    );
    // Persist through pi's section seam so the session file (and /export)
    // carries the actual prompt text, section by section, and the provider
    // cache only loses the sections that changed.
    publishPromptSections(event.systemPromptOptions, stablePrompt, volatileSections);
  });
}

export { gatherContextState, contextSection };
// Timer recovery re-export: test-timer-recovery.mjs and
// test-timer-wake-retry.mjs import through this path; owning-session
// scoping is the shared store's invariant (scheduling/timer/recovery.ts).
export { recoverPersistedTimers, dedupPersistedTimers, hasLiveEquivalent };
