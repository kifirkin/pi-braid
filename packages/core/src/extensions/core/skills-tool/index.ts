/**
 * list_skills tool — on-demand skill discovery.
 *
 * The full skill catalog is NOT rendered in-prompt (bloat reduction).
 * Instead, the agent calls this tool to discover skills by name,
 * description, path, and source, then reads the chosen SKILL.md via
 * the `read` tool. Tool output is transient — compact after reading.
 *
 * Populated by prompt-builder's `before_agent_start` via `setCachedSkills()`.
 * The cache lives in this module and is reset each session.
 *
 * One action:
 *   list — paginated catalog (name, filePath, description, source, reach)
 *
 * Each row carries the price of the read it names (see reach.ts): reachable,
 * lines, bytes, chars, a token estimate, the file's heading count, and as many
 * of its headings as the caller asked for. Picking a skill is picking a read,
 * and a price is what makes that pick rational.
 *
 * Skills discovery (list_skills tool) plus the scoring-based auto-inject
 * whisper supersede an LLM top-N recommender: a second relevance engine
 * would duplicate scoreSkill at the cost of an extra model call, against
 * the lean-prompt constraint.
 *
 * Also registers `skill_stats` — the adoption counter surface.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createLogger } from "../../../lib/core/logger.js";
import {
  registerAutoInject,
  updateSkillCache,
  getSkillStats,
  getDurableSkillStats,
  resolveDiscoveryMode,
} from "./auto-inject.js";
import { readSkillTriggers } from "./skill-triggers.js";
import {
  clampSectionsMax,
  DEFAULT_SECTIONS_MAX,
  SECTIONS_MAX_LIMIT,
  readSkillReach,
} from "./reach.js";
import { getMonthlyAdoptionRollup } from "./session-records.js";

const log = createLogger("skills-tool");

// Module-level skill cache (populated by before_agent_start)

interface CachedSkill {
  name: string;
  filePath: string;
  description: string;
  baseDir: string;
  sourceInfo?: { source?: string; package?: string };
  /**
   * pi frontmatter flag: the skill is excluded from model selection and is
   * reachable only through its explicit /skill:name command. braid must keep
   * it out of the surfaces that advertise skills to the model.
   */
  disableModelInvocation?: boolean;
  /** Frontmatter trigger phrases, resolved from SKILL.md at cache time. */
  triggers?: string[];
}

let cachedSkills: CachedSkill[] = [];

/**
 * Called from prompt-builder's before_agent_start to populate the cache.
 * Resolves each skill's frontmatter trigger phrases here, once per turn:
 * the matcher scores triggers, pi's skill objects never carry them (fixed
 * shape), and the memoized read makes repeat turns stat-only.
 */
export function setCachedSkills(skills: CachedSkill[]): void {
  cachedSkills = skills.map((s) => ({
    ...s,
    triggers: readSkillTriggers(s.filePath, s.description),
  }));
  // Sync with auto-inject subsystem (enriched cache — triggers ride along)
  updateSkillCache(cachedSkills);
  log.debug(`Cached ${skills.length} skills for list_skills tool`);
}

/**
 * The installed visible skill names — the same set the list_skills catalog
 * serves (disableModelInvocation skills excluded). Source of truth for any
 * prompt text that must name only skills the catalog actually shows.
 */
export function getCachedVisibleSkillNames(): string[] {
  return cachedSkills.filter((s) => !s.disableModelInvocation).map((s) => s.name);
}

/** Format a skill's source provenance for display. */
function formatSource(skill: CachedSkill): string {
  const si = skill.sourceInfo;
  if (!si) return "unknown";
  const src = si.source || "unknown";
  const pkg = si.package;
  if (pkg) return `package:${pkg}`;
  if (src === "user") return "user-global";
  if (src === "project") return "project";
  return src;
}

// Extension factory:

export default function skillsToolExtension(pi: ExtensionAPI): void {
  registerAutoInject(pi);

  pi.registerTool({
    name: "list_skills",
    label: "List Skills",
    description:
      "Discover skills on demand: paginated catalog (name, filePath, description, source) plus each skill's reach (reachable, lines, bytes, chars, estTokens, sectionCount, section headings with line numbers), so the price of a read is visible before the read; `read` a SKILL.md to load it.",
    parameters: Type.Object({
      action: Type.Literal("list", {
        description:
          "list = paginated catalog with per-skill reach (reachable, lines, bytes, chars, estTokens, sectionCount, sections)",
      }),
      page: Type.Optional(
        Type.Number({
          minimum: 1,
          default: 1,
          description: "Page number for list (1-based)",
        }),
      ),
      pageSize: Type.Optional(
        Type.Number({
          minimum: 1,
          maximum: 50,
          default: 10,
          description: "Entries per page for list",
        }),
      ),
      sectionsMax: Type.Optional(
        Type.Number({
          minimum: 0,
          maximum: SECTIONS_MAX_LIMIT,
          default: DEFAULT_SECTIONS_MAX,
          description:
            "Headings reported per skill; 0 omits the section list and keeps sectionCount",
        }),
      ),
    }),
    execute: async (_id, params, _signal, _onUpdate, _ctx) => {
      const page = (params.page as number) ?? 1;
      const pageSize = (params.pageSize as number) ?? 10;
      const sectionsMax = clampSectionsMax(params.sectionsMax);
      const start = (page - 1) * pageSize;
      // Explicit-invocation-only skills stay out of the catalog; the cache
      // itself stays unfiltered for the read-detector that counts explicit
      // loads.
      const visible = cachedSkills.filter((s) => !s.disableModelInvocation);
      const slice = visible.slice(start, start + pageSize);
      const total = visible.length;
      const hasMore = start + pageSize < total;

      const skills = slice.map((s) => ({
        name: s.name,
        filePath: s.filePath,
        description: (s.description ?? "").slice(0, 280),
        source: formatSource(s),
        ...readSkillReach(s.filePath, sectionsMax),
      }));

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ page, pageSize, total, hasMore, skills }, null, 2),
          },
        ],
        details: { total, page, pageSize, hasMore, returned: skills.length },
      };
    },
  });

  // Per-skill usage counters (suggested / claimed / actual / loaded) for this
  // session, plus the durable all-time counters persisted in skills-usage.json
  // (getSkillsUsageFilePath).
  // `suggested` counts DELIVERED suggestions (the whisper was accepted by the
  // tracked send path); only a detected SKILL.md read counts as actual —
  // sessionHasSkillLoad gates on actual loads, and allTimeTotals sums the
  // durable store for a one-glance adoption figure. `claimed` is the
  // honor-system reply grade; nothing produces it today, and the counter
  // stays monotone so published numbers stay readable.
  // adoption_rate = sessions_with_≥1_skill_load / sessions (measured
  // monthly, bucketed by session profile name) — the actual counter feeds
  // it, and the monthly object below is computed from the durable
  // per-session record store (see session-records.ts).
  pi.registerTool({
    name: "skill_stats",
    exposure: "deferred",
    label: "Skill Stats",
    description:
      "Per-skill usage counters this session (suggested, claimed, actual); adoption feed.",
    parameters: Type.Object({}),
    execute: async (_id, _params, _signal, _onUpdate, ctx) => {
      const stats = getSkillStats(ctx);
      const allTime = getDurableSkillStats();
      // Detected reads are the primary signal: a session where the agent only
      // verbally claimed loads does not count as an adoption session.
      const actualAny = Object.values(stats).some((s) => s.actual > 0);
      const totals = { suggested: 0, loaded: 0, claimed: 0, actual: 0 };
      let suggestedDelivered = 0;
      let suggestedMixed = 0;
      for (const s of Object.values(allTime)) {
        totals.suggested += s.suggested;
        totals.loaded += s.loaded;
        totals.claimed += s.claimed;
        totals.actual += s.actual;
        if (s.epoch === "delivered") suggestedDelivered += s.suggested;
        else suggestedMixed += s.suggested;
      }
      const monthly = getMonthlyAdoptionRollup();
      const discovery = resolveDiscoveryMode(ctx);
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                sessionHasSkillLoad: actualAny,
                skills: stats,
                allTime,
                allTimeTotals: {
                  ...totals,
                  // suggested sums BOTH regimes; suggestedDelivered counts
                  // only delivered-regime increments, suggestedMixed may
                  // include pre-delivery-regime inflation. Only a
                  // "delivered" epoch means the suggested number is clean.
                  suggestedDelivered,
                  suggestedMixed,
                  suggestedEpoch: suggestedMixed === 0 ? "delivered" : "mixed",
                },
                monthly,
                discovery: {
                  // Whether the stock skill catalog sits in the persisted
                  // transcript (it re-enters via pi's post-compaction
                  // section rebuild; braid suppresses it per-turn).
                  catalog: discovery.stockCatalogSeen ? "rebuilt" : "suppressed",
                  lastCompactionReason: discovery.lastCompactionReason,
                  checkedAt: discovery.checkedAt,
                  compactions: discovery.compactions,
                },
              },
              null,
              2,
            ),
          },
        ],
        details: {
          sessionHasSkillLoad: actualAny,
          trackedSkills: Object.keys(stats).length,
          allTimeSkills: Object.keys(allTime).length,
          allTimeTotals: { ...totals, suggestedDelivered, suggestedMixed },
          monthly,
        },
      };
    },
  });
}
