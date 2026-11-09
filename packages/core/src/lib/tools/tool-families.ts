/**
 * Tool families - which tools may be compared on reliability.
 *
 * A reliability statistic answers "how often did this tool work?" only inside a
 * population of attempts that could have been made by either tool. `taskType`
 * (see `inferTaskType` in the memory extension) is not that population: it names
 * a phase of work ("general", "file_edit", "search"), and a tool with no entry in
 * its map falls through to "general". That label therefore groups
 * `herdr_layout` (arranges terminal panes) with `fetch_content` (fetches a URL),
 * and a comparison built on it reads as advice to fetch a web page with the
 * layout tool.
 *
 * **`taskType` is a label, not a claim about what a tool does.** The claim lives
 * here: a tool is substitutable only with tools in its own family. A tool with no
 * entry in this map has no family, is not known to be comparable with anything,
 * and never produces a recommendation - a new tool joins the family map by being
 * declared, not by being observed.
 *
 * The module is pure: no state, no I/O, no imports. Callers own the statistics and
 * the session-scoped hint gate.
 */

export type ToolFamily = "web-fetch" | "terminal" | "files" | "agents" | "memory" | "orchestration";

/**
 * Which tools do the same job. Membership is a declaration about purpose, not a
 * statement that the tools are interchangeable in every argument shape: `read`
 * and `edit` are both files tools, and one reads what the other writes.
 */
export const TOOL_FAMILIES: Readonly<Record<string, ToolFamily>> = {
  fetch_content: "web-fetch",
  web_search: "web-fetch",
  get_search_content: "web-fetch",

  bash: "terminal",
  herdr_pane: "terminal",
  herdr_layout: "terminal",

  read: "files",
  write: "files",
  edit: "files",
  grep: "files",
  find: "files",
  ls: "files",

  herdr_agent: "agents",

  memory: "memory",
  memory_store: "memory",
  scratchpad: "memory",
  session: "memory",

  orchestrate: "orchestration",
  timer: "orchestration",
};

/**
 * The family of `tool`, or `null` when the tool is not declared. The own-property
 * test is deliberate: an index lookup for a name like "toString" would otherwise
 * return something off the prototype chain and read as a family.
 */
export function familyOf(tool: string): ToolFamily | null {
  return Object.prototype.hasOwnProperty.call(TOOL_FAMILIES, tool) ? TOOL_FAMILIES[tool] : null;
}

/** The part of a tool statistic this module reads. */
export interface ToolStatLike {
  tool: string;
  taskType: string;
  attempts: number;
  successes: number;
}

export interface Sample {
  attempts: number;
  successes: number;
}

export interface ToolFamilySuggestion {
  /** The tool to switch to. Same family as `tool`. */
  alternative: string;
  /** Reliability of `tool` for `taskType`, in [0, 1]. */
  current: number;
  /** Reliability of `alternative` for the same task type, in [0, 1]. */
  better: number;
  /** The failing tool's own sample. */
  sample: Sample;
  /** The alternative's sample. */
  alternatives: Sample;
  /** The tool whose failure prompted this. */
  tool: string;
  family: ToolFamily;
  taskType: string;
}

/** Both sides must carry at least this many attempts for the task type. */
export const MIN_ATTEMPTS = 5;

/**
 * The alternative must beat the failing tool by this margin. Held as the fraction
 * 1/5 so the decision runs on integer counts (see `meetsGap`) instead of the
 * subtraction of two rounded ratios.
 */
export const MIN_GAP = 0.2;

/**
 * `alternative` beats `current` by at least `MIN_GAP`, decided exactly:
 *
 *   alt.s/alt.a - cur.s/cur.a >= 1/5   <=>   5*(alt.s*cur.a - cur.s*alt.a) >= cur.a*alt.a
 *
 * The integer form matters because float subtraction puts a gap of exactly 0.2
 * (3/5 vs 2/5) at 0.19999999999999996, which would refuse a comparison the stated
 * rule allows.
 */
function meetsGap(current: ToolStatLike, alternative: ToolStatLike): boolean {
  const numerator =
    alternative.successes * current.attempts - current.successes * alternative.attempts;
  return numerator > 0 && 5 * numerator >= current.attempts * alternative.attempts;
}

/**
 * The best substitute for `tool` on `taskType`, or `null` when there is none.
 *
 * Null whenever: the tool has no declared family; the tool's own sample for this
 * task type is under `MIN_ATTEMPTS`; no same-family tool reaches `MIN_ATTEMPTS`
 * on that task type; or no such tool clears `MIN_GAP`. Ties in reliability go to
 * the lexicographically first tool name, so the same statistics always name the
 * same alternative.
 */
export function suggestAlternative(input: {
  stats: Iterable<ToolStatLike>;
  tool: string;
  taskType: string;
}): ToolFamilySuggestion | null {
  const family = familyOf(input.tool);
  if (family === null) return null;

  let current: ToolStatLike | null = null;
  const candidates: ToolStatLike[] = [];
  for (const stat of input.stats) {
    if (!stat || stat.taskType !== input.taskType) continue;
    if (stat.tool === input.tool) {
      if (current === null) current = stat;
      continue;
    }
    if (familyOf(stat.tool) === family) candidates.push(stat);
  }
  if (current === null || current.attempts < MIN_ATTEMPTS) return null;
  const failing = current;

  const qualified = candidates.filter(
    (candidate) => candidate.attempts >= MIN_ATTEMPTS && meetsGap(failing, candidate),
  );
  if (qualified.length === 0) return null;

  qualified.sort((a, b) => {
    // Descending reliability by cross-multiplication; then by name for stability.
    const byRate = b.successes * a.attempts - a.successes * b.attempts;
    if (byRate !== 0) return byRate;
    return a.tool < b.tool ? -1 : a.tool > b.tool ? 1 : 0;
  });

  const best = qualified[0];
  return {
    alternative: best.tool,
    current: failing.successes / failing.attempts,
    better: best.successes / best.attempts,
    sample: { attempts: failing.attempts, successes: failing.successes },
    alternatives: { attempts: best.attempts, successes: best.successes },
    tool: input.tool,
    family,
    taskType: input.taskType,
  };
}

/**
 * The sentence a reader receives. Both samples are on the line: a percentage
 * without its counts is what made the old hint unreadable, and a reader must be
 * able to watch the sample decide the claim. `taskType` is named because it is
 * what the counts are grouped by; the family is named because it is what makes
 * the comparison admissible in the first place.
 */
export function formatSuggestion(suggestion: ToolFamilySuggestion): string {
  const better = suggestion.alternatives;
  const current = suggestion.sample;
  return (
    `${suggestion.alternative} succeeded ${better.successes} of ${better.attempts} on ` +
    `"${suggestion.taskType}" where ${suggestion.tool} succeeded ${current.successes} of ` +
    `${current.attempts} (same tool family: ${suggestion.family})`
  );
}

/**
 * One hint per family per this many turns.
 *
 * The statistics are cumulative for the session, so between two turns the sample
 * grows while the direction of the claim does not change: a second copy of the
 * same advice carries no fact the first lacked, and a reader who sees it every
 * turn learns to filter the family out. Ten turns is long enough for a reader to
 * act (switching tools shows up as new attempts on both sides) and short enough
 * that a session which ignored the hint still sees it once more before it ends.
 */
export const HINT_COOLDOWN_TURNS = 10;

/** Per-session hint limiter. Hold it in session state, never at module scope. */
export interface FamilyHintGate {
  /** Turns completed in this session. */
  turn: number;
  /** Turn of the last emitted hint, per family. */
  lastHintTurn: Partial<Record<ToolFamily, number>>;
}

export function createFamilyHintGate(): FamilyHintGate {
  return { turn: 0, lastHintTurn: {} };
}

/** Advance the session's turn clock by one completed turn. */
export function noteTurn(gate: FamilyHintGate): void {
  gate.turn += 1;
}

/**
 * Claim the right to emit one hint for `family`. Returns `false` while the family
 * is still inside its cooldown; a `true` return records the hint at the current
 * turn, so the caller must emit when it gets one.
 */
export function allowFamilyHint(gate: FamilyHintGate, family: ToolFamily): boolean {
  const last = gate.lastHintTurn[family];
  if (last !== undefined && gate.turn - last < HINT_COOLDOWN_TURNS) return false;
  gate.lastHintTurn[family] = gate.turn;
  return true;
}
