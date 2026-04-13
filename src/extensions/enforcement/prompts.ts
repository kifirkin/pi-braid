/**
 * Enforcement prompts - Prompt templates and rules
 */

export const PRE_TURN_TEMPLATE = `
## Enforcement: Good Practices

- Think before acting, read before editing, plan before changing
- Test before claiming done, run tests to verify
- Store important learnings in memory (memory_store)
`;

export const TOOL_ENFORCEMENT_RULES = `
## Tool Usage Best Practices

- Read → plan → edit → test → verify → store in memory
- You verify before claiming done
`;

export const POST_TURN_VALIDATION_TEMPLATE = `
## Turn Validation Failed

Your last turn had the following issues:
{issues}

This violates the enforcement rules. Review and correct your approach.
`;
