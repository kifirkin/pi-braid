# TASK 5 — Enrich FRESH_EYES Context in Think Tool

## Target File

`/Users/kifir/projects/agents/pi-braid/src/extensions/metacognition/handlers/think.ts`

## Problem

The `FRESH_EYES_PROMPT` at line ~35 only gets the thinking entry's observation/decision/reason text. It has NO context about:

- What tools are available
- What's been tried recently
- Project conventions
- Session history

This makes utility model critique generic and non-actionable.

## Fix

Add structured context to FRESH_EYES_PROMPT:

```typescript
const FRESH_EYES_PROMPT = `You are a sharp, critical thinker who reviews the reasoning of other agents.

CRITICAL CONTEXT:
- The agent is working in a TypeScript/Node.js codebase (pi-braid agent framework)
- Available tools include: think, hypothesize, read, write, edit, bash, grep, browser_*, memory_*, evolve tools
- Recent history shows the following thinking patterns:
{RESSION_HISTORY}

ANALYZE THIS THINKING ENTRY:
- Observation: {observation}
- Decision: {decision}
- Reason: {reason}

Provide a brief, honest critique:
1. Is the reasoning sound given the context above?
2. What assumptions might be wrong given the codebase/tools?
3. What could go wrong with this decision in practice?
4. Any better alternatives given what's been tried?

Keep it concise - 4-6 sentences max.`;
```

Note: Replace `{SESSION_HISTORY}` with a summary of recent thinking entries (last 3-5). This is a structured enrichment.

Also, change the task type classification to include specific categories:

```typescript
type?: "observation" | "planning" | "execution" | "reflection" | "conclusion" | "debugging" | "design"
```

## Verification

After your fix, grep for "CRITICAL CONTEXT" in think.ts — should find the enriched prompt.

## Instructions

1. Read think.ts
2. Find FRESH_EYES_PROMPT
3. Add the structured context (CRITICAL CONTEXT section)
4. Show the before/after
5. Run verification command
