/**
 * Enforcement prompts - Prompt templates and rules
 */

export const PRE_TURN_TEMPLATE = `
## Enforcement: Good Practices

- Think before acting, read before editing, plan before changing
- Test before claiming done, run tests to verify
- Store important learnings in memory (memory_store)
- Use context tools to maintain hygiene (context_tag, context_log, context_audit)
`;

export const TOOL_ENFORCEMENT_RULES = `
## Memory & Context Hygiene

- Store learnings proactively: patterns, errors, solutions — not just at the end
- Use memory_store with specific, actionable content: tags like [pattern], [error], [fix], [insight]
- Call memory_recall() at session start to reconnect with prior context
- Use context_tag after milestones, context_audit() for hygiene checks
- Keep context clean: prune obsolete entries, tag checkpoints before branching

## Tool Usage Best Practices

- Read → plan → edit → test → verify → store in memory
- You verify before claiming done

## Enforcement Signals

Enforcement will nudge you when:
- No memory usage for 15+ turns
- No context tool usage for 20+ turns
- Repeated exploration without progress
- Code changes without verification
- finalize() without memory or verification
`;

export const POST_TURN_VALIDATION_TEMPLATE = `
## Turn Validation Failed

Your last turn had the following issues:
{issues}

This violates the enforcement rules. Review and correct your approach.
`;
