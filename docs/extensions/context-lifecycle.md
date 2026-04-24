# Extension: context-lifecycle

**Status**: ✅ Working
**Tests**: None (handlers tested via context-manager tests)
**Version**: v0.13.0

## Purpose

S-MMU Active Context Management. AUTOMATION layer that works with context-manager (no new tools). Uses existing `context_tag`, `context_compress`, `context_signal` tools. R-CCAM-inspired loop.

## R-CCAM Loop

| Stage | Description |
|-------|-------------|
| Retrieval | Signal detection from session content |
| Cognition | Policy evaluation with governance |
| Control | Action selection with constraint checking |
| Action | Proposal injection or immediate execution |
| Memory | CustomEntry persistence with outcome tracking |

## Tools (2)

| Tool | Description |
|------|-------------|
| `context_proposals` | List/approve/reject/snapshot S-MMU proposals |
| `context_signal` | Emit semantic signals to policy engine |

## Events (3)

| Event | Description |
|-------|-------------|
| `session_start` | Initialize policies, clear state |
| `message_end` | Update proposal counts |
| `session_shutdown` | Cleanup |

## Custom Entry Types

| Type | Format |
|------|--------|
| `ContextProposal` | `context_proposals` custom entry |
| `ContextSnapshot` | `context_signal` snapshot |

## Proposal System

- Max 2 proposals per turn
- Max 10 proposals per session
- TTL eviction at 30min
- Outcome tracking (closed-loop feedback)

## Sub-modules

| Module | Purpose |
|--------|---------|
| `types.ts` | Proposal, snapshot, policies |
| `policy-engine.ts` | Policy evaluation engine |
| `signal-detector.ts` | Signal detection from context |
