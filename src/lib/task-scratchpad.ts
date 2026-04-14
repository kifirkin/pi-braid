/**
 * TaskScratchpad - Per-loop state that persists across turns.
 *
 * Dies when task completes.
 * Maintains continuity of thought without bloating context.
 */

export interface TaskScratchpad {
	/** Original goal/task */
	goal: string;
	/** Steps to complete */
	plan: string[];
	/** Steps completed */
	done: string[];
	/** Key decisions made */
	decisions: string[];
	/** Multiple hypotheses (for debugging) */
	hypotheses: string[];
	/** Notes/thoughts */
	notes: string[];
}

export function createScratchpad(goal: string): TaskScratchpad {
	return {
		goal,
		plan: [],
		done: [],
		decisions: [],
		hypotheses: [],
		notes: [],
	};
}

export function formatScratchpad(pad: TaskScratchpad): string {
	const lines = [`Goal: ${pad.goal}`];

	if (pad.plan.length > 0) {
		lines.push("\nPlan:");
		for (let i = 0; i < pad.plan.length; i++) {
			const step = pad.plan[i];
			const status = pad.done.includes(step) ? "[done]" : "[ ]";
			lines.push(`  ${status} ${i + 1}. ${step}`);
		}
	}

	if (pad.decisions.length > 0) {
		lines.push("\nDecisions:");
		for (const d of pad.decisions) {
			lines.push(`  - ${d}`);
		}
	}

	if (pad.hypotheses.length > 0) {
		lines.push("\nHypotheses:");
		for (let i = 0; i < pad.hypotheses.length; i++) {
			lines.push(`  ${i + 1}. ${pad.hypotheses[i]}`);
		}
	}

	if (pad.notes.length > 0) {
		lines.push("\nNotes:");
		for (const n of pad.notes) {
			lines.push(`  - ${n}`);
		}
	}

	return lines.join("\n");
}
