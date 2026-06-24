<!-- status: current -->

# Context Lifecycle Extension

The AUTOMATION layer for context management. Works WITH
`context-manager` (which exposes the tools) - does NOT expose new tools.
Implements the R-CCAM (Retrieval-Cognition-Control-Action-Memory) loop
in cognitive-memory theory.

## Architecture

| File                | Purpose                                                                                  |
| ------------------- | ---------------------------------------------------------------------------------------- |
| `index.ts`          | Extension entry point; registers event listeners and proposal handler                    |
| `state.ts`          | Session-scoped state (proposals, decisions, history)                                     |
| `types.ts`          | Type definitions for proposals, policies, signals                                       |
| `policy-engine.ts`  | Evaluates a proposal against active policies (token budget, cooldown, etc.)              |
| `signal-detector.ts`| Detects when the agent is approaching context limits from session content                |
| `helpers.ts`        | Shared utilities                                                                          |

## What it does

The R-CCAM loop runs on `turn_end`:

1. **Retrieval**: `signal-detector.ts` scans the latest turn for signals
   (high token growth, error patterns, repeated tools)
2. **Cognition**: `policy-engine.ts` evaluates a proposed action (e.g.
   "archive 30% of older messages")
3. **Control**: Constraint check (cooldown, cost-benefit, agent's
   recent explicit instructions)
4. **Action**: Either inject a `propose` entry for the agent to act on,
   or auto-execute if the policy says so
5. **Memory**: Record the outcome (proposed/accepted/rejected/auto-executed)
   for meta-learning

## Relationship to context-manager

`context-manager` exposes the LLM-callable tools (`context_compress`,
`context_navigate`, `context_inspect`, `context_archive`,
`context_proposals`). `context-lifecycle` AUTOMATES the use of those
tools by detecting when they're needed and either proposing them
(via custom entry) or executing them directly.

**The LLM never calls context-lifecycle directly** - it's a daemon.
The LLM can call the context-manager tools at any time, in which case
context-lifecycle sees the result and updates its state.

## Event-bus contract

| Emits    | Listens to        |
| -------- | ----------------- |
| (none)   | `memory_evict` (from `lib/store/...`) - updates its own state |

## Local Contracts

- **Session-scoped state** via `getExtensionState(ctx, key, factory)`.
- **No new tools** - the design is "extend the agent's context
  awareness without adding to its tool inventory".
- **Proposal injection** uses `customEntry` (`propose` type) so the
  LLM sees it as a suggestion, not an instruction.
- **Cooldown**: proposals of the same type are debounced for N turns
  (default 5) to avoid nagging the agent.
