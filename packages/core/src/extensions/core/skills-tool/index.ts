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
 *   list — paginated catalog (name, filePath, description, source, reach),
 *          ordered by relevance to the current task unless `rank: "catalog"`.
 *
 * Each row carries the price of the read it names (see reach.ts): reachable,
 * lines, bytes, chars, a token estimate, the file's heading count, and as many
 * of its headings as the caller asked for. Picking a skill is picking a read,
 * and a price is what makes that pick rational.
 *
 * The ordering is the deterministic scorer's answer (see `resolveRanking`):
 * auto-inject.ts owns the ranking, and this handler owns only what needs the
 * extension context — the task text (from the session branch) and the
 * `braid.skills.ranking` policy, which is read and echoed rather than acted on
 * while no model tier exists.
 *
 * Skills discovery (list_skills tool) plus the scoring-based auto-inject
 * whisper supersede an LLM top-N recommender: a second relevance engine
 * would duplicate scoreSkill at the cost of an extra model call, against
 * the lean-prompt constraint.
 *
 * Also registers `skill_stats` — the adoption counter surface.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { Static } from "typebox";
import { createLogger } from "../../../lib/core/logger.js";
import { getSkillsRankingMode } from "../../../lib/config/braid-settings.js";
import type { SkillsRankingMode } from "../../../lib/config/braid-settings.js";
import {
  registerAutoInject,
  updateSkillCache,
  getSkillStats,
  getDurableSkillStats,
  resolveDiscoveryMode,
  rankSkillsDeterministic,
} from "./auto-inject.js";
import type { DeterministicRanking, RankedSkill, RelevanceReason } from "./auto-inject.js";
import { readSkillTriggerEntries } from "./skill-triggers.js";
import type { TriggerSource } from "./skill-triggers.js";
import {
  clampSectionsMax,
  DEFAULT_SECTIONS_MAX,
  SECTIONS_MAX_LIMIT,
  readSkillReach,
} from "./reach.js";
import { getMonthlyAdoptionRollup, getSessionApplicability } from "./session-records.js";
import { checkArgumentValues } from "../../../lib/utils/argument-report.js";

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
  /** Which source authored each phrase (a ranking row reports it). */
  triggerSources?: Record<string, TriggerSource>;
}

let cachedSkills: CachedSkill[] = [];

/**
 * Called from prompt-builder's before_agent_start to populate the cache.
 * Resolves each skill's frontmatter trigger phrases here, once per turn:
 * the matcher scores triggers, pi's skill objects never carry them (fixed
 * shape), and the memoized read makes repeat turns stat-only.
 */
export function setCachedSkills(skills: CachedSkill[]): void {
  cachedSkills = skills.map((s) => {
    const entries = readSkillTriggerEntries(s.filePath, s.description);
    const triggerSources: Record<string, TriggerSource> = {};
    for (const entry of entries) triggerSources[entry.phrase] = entry.source;
    return { ...s, triggers: entries.map((entry) => entry.phrase), triggerSources };
  });
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

// Relevance ranking: the deterministic order
//
// A model tier was built here and measured against this scorer: it never lost
// a case and won the two prose prompts the scorer misses, but it did not clear
// its pre-registered bar, and a tier that buys two wins with a call on every
// ambiguous read is a finding about the scorer, not a feature. So the read is
// answered by rankSkillsDeterministic() alone: no provider, no cache, no
// counters. The `braid.skills.ranking` setting and the `ranking` report
// survive because they are the seam a later tier plugs into.

/** The evidence label a row reports (see RelevanceReason in auto-inject.ts). */
export type RowRelevanceReason = RelevanceReason;

/** What a ranked row says about its own position. */
export interface RowRelevance {
  /** The deterministic score behind the row. */
  score: number;
  reason: RowRelevanceReason;
}

/** Why the deterministic verdict is what it is, and who answered. */
export interface RankingReport {
  /** Always "keyword": the deterministic scorer is the only tier. */
  tier: "keyword";
  basis: DeterministicRanking["basis"];
  /**
   * The configured `braid.skills.ranking` value, echoed so an operator can see
   * what the policy asked for. Only "keyword" has an implementation today; the
   * other two are reserved for a model tier that was measured and not kept, and
   * they evaluate to the keyword path.
   */
  policy: SkillsRankingMode;
}

/**
 * The current task text: the newest user message on the live branch.
 *
 * A tool call carries no prompt of its own and pi hands tools no turn prompt,
 * but the branch does — and its newest user message is the task the agent is
 * working on. A resumed session therefore ranks against its real task even
 * though this process never saw the prompt arrive. Best-effort: no branch, an
 * unreadable entry, or a non-text message yields "", and the caller then
 * returns the catalog order rather than inventing a task.
 */
export function currentTaskText(ctx: ExtensionContext): string {
  try {
    const sm = (ctx as { sessionManager?: { getBranch?: () => unknown[] } }).sessionManager;
    const branch = sm?.getBranch?.() ?? [];
    for (let i = branch.length - 1; i >= 0; i--) {
      const entry = branch[i] as { type?: string; message?: { role?: string; content?: unknown } };
      if (entry?.type !== "message" || entry.message?.role !== "user") continue;
      const content = entry.message.content;
      if (typeof content === "string") return content;
      if (Array.isArray(content)) {
        return content
          .map((part) => part as { type?: string; text?: string })
          .filter((part) => part?.type === "text" && typeof part.text === "string")
          .map((part) => part.text as string)
          .join("\n");
      }
      return "";
    }
  } catch {
    // Best-effort: a stale ctx or an absent tree yields no text.
  }
  return "";
}

/** Reorder `skills` by `names`, appending everything the list did not mention. */
function orderByNames(skills: CachedSkill[], names: string[]): CachedSkill[] {
  const byName = new Map(skills.map((s) => [s.name, s]));
  const out: CachedSkill[] = [];
  for (const name of names) {
    const skill = byName.get(name);
    if (!skill) continue;
    byName.delete(name);
    out.push(skill);
  }
  for (const skill of skills) if (byName.has(skill.name)) out.push(skill);
  return out;
}

/** One catalog read's complete ranking answer. */
export interface RankingAnswer {
  order: CachedSkill[];
  /** Absent for `rank: "catalog"` — an unranked read has no tier or evidence. */
  ranking?: RankingReport;
  relevance: Map<string, RowRelevance>;
}

/**
 * Resolve the catalog order for one read.
 *
 * `keyword` and `catalog` are the two answers: the deterministic ranking (with
 * its verdict on how confident that ranking is), or the plain catalog. A
 * missing task text is nobody's question, so the catalog order stands and the
 * report says `no-task` rather than pretending to rank.
 */
export function resolveRanking(
  ctx: ExtensionContext,
  skills: CachedSkill[],
  options: { rank: "relevance" | "catalog"; policy?: SkillsRankingMode },
): RankingAnswer {
  if (options.rank === "catalog") return { order: skills, relevance: new Map() };

  const det = rankSkillsDeterministic(skills, currentTaskText(ctx));
  const relevance = new Map<string, RowRelevance>();
  for (const row of det.ranked) relevance.set(row.skill.name, rowOf(row));
  const order =
    det.basis === "no-task"
      ? skills
      : orderByNames(
          skills,
          det.ranked.map((row) => row.skill.name),
        );
  return {
    order,
    ranking: {
      tier: "keyword",
      basis: det.basis,
      policy: options.policy ?? getSkillsRankingMode(),
    },
    relevance,
  };
}

/** A ranked row as the response reports it (only rows with evidence get here). */
function rowOf(row: RankedSkill): RowRelevance {
  return { score: row.score, reason: row.reason ?? "description" };
}

// Extension factory:

/**
 * `list_skills` arguments: one action, one page of the catalog.
 *
 * The action is named here rather than inferred, because a pager call and a
 * full-catalog call are the same call and the schema is what the model reads
 * before choosing. The tool fills it when the call omits it (`prepareArguments`
 * below), so a bare pager call behaves as the listing it obviously is while an
 * unknown action is still refused.
 */
const listSkillsSchema = Type.Object({
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
      description: "Headings reported per skill; 0 omits the section list and keeps sectionCount",
    }),
  ),
  rank: Type.Optional(
    Type.Union([Type.Literal("relevance"), Type.Literal("catalog")], {
      default: "relevance",
      description:
        "relevance (default) = order by fit to the current task; catalog = the plain catalog order, with no ranking fields",
    }),
  ),
});

export default function skillsToolExtension(pi: ExtensionAPI): void {
  registerAutoInject(pi);

  pi.registerTool({
    name: "list_skills",
    label: "List Skills",
    description:
      "Discover skills on demand: paginated catalog (name, filePath, description, source) plus each skill's reach (reachable, lines, bytes, chars, estTokens, sectionCount, section headings with line numbers), so the price of a read is visible before the read. Rows are ordered by relevance to the current task; a row with match evidence carries relevance {score, reason}, and the response carries ranking {tier, basis, policy}. Pass rank: 'catalog' for the plain catalog order. `read` a SKILL.md to load it.",
    parameters: listSkillsSchema,
    // Paging without an action is a listing call: fill the action the call
    // implies before pi validates, and refuse a guessed value with the accepted
    // one named. The schema above stays the only description of the contract.
    prepareArguments: (args: unknown) => {
      const prepared =
        args && typeof args === "object" && (args as { action?: unknown }).action == null
          ? { ...args, action: "list" }
          : args;
      checkArgumentValues("list_skills", listSkillsSchema, prepared);
      return prepared as Static<typeof listSkillsSchema>;
    },
    execute: async (_id, params, signal, _onUpdate, ctx) => {
      const page = (params.page as number) ?? 1;
      const pageSize = (params.pageSize as number) ?? 10;
      const sectionsMax = clampSectionsMax(params.sectionsMax);
      const rank = (params.rank as "relevance" | "catalog" | undefined) ?? "relevance";
      // Explicit-invocation-only skills stay out of the catalog; the cache
      // itself stays unfiltered for the read-detector that counts explicit
      // loads.
      const visible = cachedSkills.filter((s) => !s.disableModelInvocation);
      const answer = resolveRanking(ctx, visible, { rank });
      const total = answer.order.length;
      const start = (page - 1) * pageSize;
      const slice = answer.order.slice(start, start + pageSize);
      const hasMore = start + pageSize < total;

      const skills = slice.map((s) => ({
        name: s.name,
        filePath: s.filePath,
        description: (s.description ?? "").slice(0, 280),
        source: formatSource(s),
        ...readSkillReach(s.filePath, sectionsMax),
        // Evidence where it exists: a row with no match carries no relevance
        // field. Every row paying ~60 bytes for "nothing matched" pushed the
        // shipped page past its measured prompt budget (12.0KB -> 12.8KB), and
        // the empty object carried no information the absence does not.
        ...(answer.relevance.has(s.name) ? { relevance: answer.relevance.get(s.name) } : {}),
      }));

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                page,
                pageSize,
                total,
                hasMore,
                ...(answer.ranking ? { ranking: answer.ranking } : {}),
                skills,
              },
              null,
              2,
            ),
          },
        ],
        details: {
          total,
          page,
          pageSize,
          hasMore,
          returned: skills.length,
          ...(answer.ranking ? { tier: answer.ranking.tier, basis: answer.ranking.basis } : {}),
        },
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
      // The session's skill verdicts (read | ignored, plus the not-applicable
      // remainder of the census) from the durable record, never from memory:
      // the point of the record is that it outlives the turn that saw it.
      // Absent when the session wrote none — an older store, or a session that
      // never reached a task text — so an exhausted reader of the old counters
      // keeps byte-identical output. Only the verdict classes are summarized in
      // details; the full evidence stays in the text payload.
      const recorded = getSessionApplicability(ctx);
      const applicability = recorded
        ? {
            taskChars: recorded.taskChars,
            evaluated: recorded.evaluated,
            undeclared: recorded.undeclared,
            classes: recorded.classes,
            verdicts: recorded.verdicts,
            updatedAt: recorded.updatedAt,
          }
        : undefined;
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
                ...(applicability ? { applicability } : {}),
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
          ...(applicability ? { applicability: applicability.classes } : {}),
        },
      };
    },
  });
}
