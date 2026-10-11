/**
 * Scratchpad formatting - display/format functions for the scratchpad.
 *
 * Formats the scratchpad state into human-readable strings for the agent.
 */

import type { TaskScratchpad } from "./types.js";

export function formatScratchpad(
  pad: TaskScratchpad,
  filter?: {
    ids?: string[];
    sinceTurn?: number;
    untilTurn?: number;
    category?: string;
    limit?: number;
  },
): string {
  const lines: string[] = [];
  lines.push(`Goal: ${pad.goal}`);
  if (pad.prior_goal) lines.push(`Prior goal: ${pad.prior_goal}`);

  const applyListFilter = <T extends { id: string; turn?: number }>(list: T[]): T[] => {
    let out = list;
    if (filter?.ids && filter.ids.length > 0) {
      const idSet = new Set(filter.ids);
      out = out.filter((it) => idSet.has(it.id));
    }
    if (filter?.sinceTurn !== undefined) {
      out = out.filter((it) => (it.turn ?? 0) >= (filter.sinceTurn ?? 0));
    }
    if (filter?.untilTurn !== undefined) {
      out = out.filter((it) => (it.turn ?? 0) <= (filter.untilTurn ?? 0));
    }
    if (filter?.limit !== undefined && filter.limit > 0 && out.length > filter.limit) {
      out = out.slice(-filter.limit);
    }
    return out;
  };

  const filteredPlan = applyListFilter(pad.plan);
  if (filteredPlan.length > 0) {
    lines.push("\nPlan:");
    for (let i = 0; i < filteredPlan.length; i++) {
      const step = filteredPlan[i];
      const status = step.doneTurn > 0 ? "[ok]" : step.startTurn > 0 ? "[..]" : "[ ]";
      const budget = step.budgetCalls ? `/${step.budgetCalls}` : "";
      const over = step.budgetCalls && step.spentCalls > step.budgetCalls ? " [warn]" : "";
      lines.push(
        `  ${i + 1}. ${status} ${step.text} [${step.spentCalls}${budget} calls${over}] (${step.id})`,
      );
    }
  }

  const filteredDone = applyListFilter(pad.done);
  if (filteredDone.length > 0) {
    lines.push(`\nDone (${filteredDone.length}${filter ? ` of ${pad.done.length}` : ""}):`);
    for (const d of filteredDone) lines.push(`  [ok] ${d.text} (${d.id})`);
  }

  const filteredDecisions = applyListFilter(pad.decisions);
  if (filteredDecisions.length > 0) {
    lines.push("\nDecisions:");
    for (const d of filteredDecisions.slice(-5)) {
      lines.push(`  - ${d.text}${d.reason ? ` (${d.reason})` : ""} (${d.id})`);
    }
  }

  const filteredNotes = applyListFilter(pad.notes);
  if (filteredNotes.length > 0) {
    lines.push("\nNotes:");
    for (const n of filteredNotes.slice(-5)) lines.push(`  ${n.text} (${n.id})`);
  }

  if (pad.constraints.length > 0) {
    lines.push("\nConstraints:");
    for (const c of pad.constraints.slice(-3)) {
      lines.push(`  [${c.type}] ${c.description}${c.acknowledged ? " (acknowledged)" : ""}`);
    }
  }
  if (pad.key_learnings.length > 0) {
    lines.push(`\nLearnings (${pad.key_learnings.length}):`);
    for (const l of pad.key_learnings.slice(-3)) {
      lines.push(`  [${l.category}] ${l.content}`);
    }
  }

  return lines.join("\n");
}

/**
 * Resumption digest for "continue" -- the focused summary a fresh session
 * needs to pick up work without reading the entire scratchpad.
 */
export function formatContinueDigest(pad: TaskScratchpad): string {
  const lines: string[] = [];
  lines.push(`# Resumption digest`);
  lines.push("");
  lines.push(`Goal: ${pad.goal}`);
  if (pad.prior_goal && pad.prior_goal !== pad.goal) {
    lines.push(`Prior goal: ${pad.prior_goal}`);
  }
  lines.push("");

  const openPlan = pad.plan.filter((s) => s.doneTurn === 0);
  if (openPlan.length > 0) {
    lines.push(`## Open plan (${openPlan.length})`);
    for (let i = 0; i < openPlan.length; i++) {
      const step = openPlan[i];
      const status = step.startTurn > 0 ? "[..]" : "[ ]";
      const budget = step.budgetCalls ? ` [budget: ${step.budgetCalls}]` : "";
      lines.push(`  ${i + 1}. ${status} ${step.text}${budget}`);
    }
    lines.push("");
  } else {
    lines.push(`## Open plan: (none)`);
    lines.push("");
  }

  if (pad.done.length > 0) {
    const lastDone = pad.done.slice(-3);
    lines.push(`## Recently completed`);
    for (const d of lastDone) lines.push(`  [ok] ${d.text}`);
    lines.push("");
  }

  if (pad.decisions.length > 0) {
    const lastDec = pad.decisions.slice(-3);
    lines.push(`## Recent decisions`);
    for (const d of lastDec) {
      lines.push(`  - ${d.text}${d.reason ? ` (${d.reason})` : ""}`);
    }
    lines.push("");
  }

  if (pad.notes.length > 0) {
    const lastNotes = pad.notes.slice(-3);
    lines.push(`## Recent notes`);
    for (const n of lastNotes) lines.push(`  ${n.text}`);
    lines.push("");
  }

  const activeConstraints = pad.constraints.filter(
    (c) => !c.acknowledged || c.expires_at === 0 || c.expires_at > Date.now(),
  );
  if (activeConstraints.length > 0) {
    lines.push(`## Active constraints (${activeConstraints.length})`);
    for (const c of activeConstraints.slice(0, 3)) {
      lines.push(`  [${c.type}] ${c.description}`);
    }
    lines.push("");
  }

  if (pad.session.turn > 0) {
    lines.push(
      `## Session: turn=${pad.session.turn}, phase=${pad.session.phase}, mode=${pad.session.mode}`,
    );
  }

  return lines.join("\n");
}
