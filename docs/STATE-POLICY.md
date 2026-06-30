<!-- status: current -->

# State Policy — Design Document

**Status:** Active. Last revised 2026-06-17.
**Source of truth:** `src/lib/state/AGENTS.md`. This document explains the *why* behind the policy in narrative form.

## Overview

pi-braid has four overlapping state lifetimes, each with a correct home:

| Lifetime | Scope | Pattern | File |
|---|---|---|---|
| **Function-call** | One async function's frame | Local `const` | (any) |
| **Per-session, per-extension** | One session, one extension's state slot | `getExtensionState(ctx, key, factory)` | `lib/state/extension-state.ts` |
| **Per-session, cross-extension** | One session, shared across multiple extensions | `getExtensionState` with a shared key | `lib/state/extension-state.ts` |
| **Process-global** | The whole process, across all sessions | `get*()` getter in `global-state.ts` | `lib/state/global-state.ts` |
| **Sync re-entry guard** | Synchronous call stack only | Module-level `let` (exception) | (exempted sites, see AGENTS.md) |

The runtime model is **one process per pi session, with multiple extensions in that process**. A "session" starts when the user opens pi and ends when they close it. Within one session, the agent may have many "turns" (user messages + LLM responses). The state must survive all of those turns.

## Why per-session state is the default

Most state in pi-braid is per-session:
- A scratchpad of plans and learnings belongs to one session
- The current goal belongs to one session
- Compaction history belongs to one session
- The current agent's "behavior mode" belongs to one session

These are all data the LLM uses in its reasoning during one session, but should NOT leak into the next session (a fresh session is a fresh context with fresh goals).

`getExtensionState(ctx, key, factory)` is the canonical pattern because:
1. **It's keyed by session + extension.** A new session gets a fresh slot.
2. **It's lazily initialized.** The factory only runs on first access, not on module load.
3. **It's test-isolatable.** Tests can pass a mock ctx and get a fresh slot.
4. **It survives across turns within a session.** The state is held in a `WeakMap`-like structure keyed by the ctx's session id.

## Why process-global state is rare

Process-global state is rare because it leaks across sessions. Examples of legitimate process-global state:

1. **Custom model keys** (`/vision-model`, `/utility-model` commands). Set once by the user, used by every session to resolve the model spec. Not session-specific.
2. **Resolved model specs** (cached LLM responses for model metadata). Reusing across sessions saves 1-2 HTTP roundtrips.
3. **Singleton class instances** (the `CognitiveMemory` engine). Rebuilding the in-memory indices is expensive (~50ms+); the data is restored from disk anyway.

`global-state.ts` is the home for these because:
1. **Centralized documentation.** Every process-global slot is listed in one file with a justification.
2. **Auditable.** The "Q5 audit" can grep `global-state.ts` and confirm the count.
3. **Easily tested.** Reset functions (if any) are colocated.

## Why module-level `let` is banned

Module-level `let` is the worst of both worlds:
- It **leaks across sessions** (like process-global) but
- It is **not documented in one place** (unlike `global-state.ts`)
- It **isn't keyed by session** (unlike `getExtensionState`)
- It **isn't reset on session_start** (unlike both)

Most "I need to remember X across function calls" needs are either per-session (use `getExtensionState`) or process-global (add to `global-state.ts`). The only legitimate use of module-level `let` is the re-entry guard pattern.

## The re-entry guard exception

The runtime can call an extension's `before_agent_start` hook synchronously inside the extension's own `pi.sendMessage` call. If the extension uses `getExtensionState` for its re-entry counter, the counter is keyed by session, so it correctly persists across re-entries within a session. But the re-entry counter needs to be visible to code that doesn't have a ctx, and the synchronous call chain can't safely re-enter `getExtensionState`. The module-level `let` is the simplest correct pattern.

The 28 documented exceptions (in `src/lib/state/AGENTS.md` "Documented exceptions" table) all match this pattern or its near variants. They are explicitly enumerated so future contributors can:
- See the list, and
- Avoid adding new `let` declarations without consulting this doc.

## Migration path for new state

When a new state is needed:

1. **Will the user want this reset on session_start?** Yes → `getExtensionState(ctx, "key", factory)`.
2. **No, this is set once and used forever?** → Add a getter to `global-state.ts`.
3. **No ctx is available at the read site?** → If a `global-state.ts` getter works, use it. If not (sync re-entry guard pattern), add a `let` to the Documented exceptions table.
4. **Is this a test-injectable function slot?** → Module-level `let` is fine. (Example: `lib/utils/id.ts` `_idGenerator` and `_randomSuffix`.)

## Audit history

| Date | Action | Result |
|---|---|---|
| 2026-06-13 | First Q5 audit | 7 sites migrated to `getExtensionState`. 2 documented exceptions. |
| 2026-06-17 | Second Q5 audit (this session) | 2 additional sites (`nudge-analytics`, `memory singleton`) moved to `global-state.ts`. AGENTS.md updated. |
| 2026-06-17 | `test-no-module-level-let.mjs` added | Scan-style lint test. Fails CI if a new `let` appears outside the documented exceptions. |

## See also

- `src/lib/state/AGENTS.md` - the policy table (the "what")
- `docs/CODE-QUALITY-REMEDIATION-PLAN.md` Q5, Q7 - the audit history
- `docs/archive/Q13-SPLIT-INDEX-STATUS.md` (archived 2026-06-17) - related cleanup of large index.ts files
