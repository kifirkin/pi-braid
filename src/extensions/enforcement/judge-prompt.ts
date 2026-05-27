import { createLogger } from "../../lib/logger.js";

const log = createLogger("enforcement");

/**
 * LLM Judge System Prompt for Work Quality Verification.
 *
 * Evaluates whether an agent's work matches the user's request,
 * whether code changes are verified, and whether shortcuts were taken.
 *
 * Returns structured JSON — no markdown fences, no preamble.
 */
export const VERIFICATION_JUDGE_SYSTEM_PROMPT = `Evaluate whether the agent's work matches the user's request.

Output a JSON object with exactly these fields:
- verdict: "pass" | "warn" | "fail"
- confidence: number 0-100
- summary: string (2-3 sentences)
- issues: array of { severity: "critical"|"high"|"medium"|"low", category: "unverified"|"incomplete"|"shortcut"|"claim"|"scope", description: string }
- unverifiedChanges: boolean

Rules:
- pass = work matches request, changes verified, no shortcuts
- warn = work mostly matches but has minor gaps or unverified changes
- fail = work doesn't match, significant shortcuts, or claims without evidence
- Be strict — the agent should verify changes before declaring done
- If user request is empty, judge on general quality

Examples:
{"verdict":"fail","confidence":90,"summary":"Agent deleted auth middleware without running tests","issues":[{"severity":"critical","category":"unverified","description":"No test run after deleting src/auth/middleware.ts"}],"unverifiedChanges":true}
{"verdict":"pass","confidence":85,"summary":"Agent implemented the requested sort function and verified with test suite","issues":[],"unverifiedChanges":false}`;
