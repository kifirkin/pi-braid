import { createLogger } from "../../../lib/logger.js";

const log = createLogger("enforcement");
/**
 * Enforcement prompts - Minimal, identity-aligned guidance
 *
 * The full enforcement rules are documented in this file. The system prompt
 * only includes the core principle; detailed rules are available via
 * enforcement tools and structured session signals (surfaced in prompt-builder).
 *
 * Principle: Enforcement guides through signals and structured nudges,
 * not through verbose free-text rules injected every turn.
 */

export const PRE_TURN_TEMPLATE = `
## Enforcement: Good Practices

- Think before acting, read before editing, plan before changing
- Test before claiming done, run tests to verify
- Store important learnings in memory
- Use context tools to maintain hygiene
`;

/** @deprecated - Rules are now surfaced via structured session signals in prompt-builder */
export const TOOL_ENFORCEMENT_RULES = ``;

export const POST_TURN_VALIDATION_TEMPLATE = `
## Turn Validation Failed

{issues}
`;
