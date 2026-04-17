# Context Lifecycle Design - IMPLEMENTED

## Architecture: Lean, Integrated, No Duplicates

**Design principle**: Extensions are isolated. State sharing via SessionManager only.

```
context-manager (BEFORE)          context-lifecycle (AFTER)
┌────────────────────────┐      ┌────────────────────────┐
│ 6 tools:               │      │ 2 tools:               │
│ - context_tag            │      │ - context_proposals    │
│ - context_log            │      │ - context_signal        │
│ - context_checkout       │ ←────│   (auto-proposals via  │
│ - context_prune         │   Session  CustomMessageEntry) │
│ - context_audit         │   Manager │                      │
│ - context_compress      │      └────────────────────────┘│
│                         │                                 │
│ + rule-based pruning     │      + S-MMU policy engine    │
│ + compaction hooks       │      + Signal detection       │
│ + tree nav hooks         │      + Auto-snapshots        │
│ + CustomEntry storage    │      + Proposal injection     │
└────────────────────────┘      └─────────────────────────┘
```

## Integration: CustomEntry Communication

**Problem**: Extensions can't share runtime state.

**Solution**: All state stored in SessionManager.

| Data | CustomType | Visibility |
|------|------------|------------|
| Proposals | `context-lifecycle:proposal` | CustomMessageEntry → shown to LLM |
| Snapshots | `context-lifecycle:snapshot` | CustomEntry → persisted |

## Signal Detection (from Session Content)

**Problem**: Can't read enforcement/scratchpad state.

**Solution**: Analyze SessionManager entries directly.

```
Session entries → Text extraction → Keyword analysis → Topic detection
                           ↓
                 Tool patterns → Task boundaries
                           ↓
                 Content hashing → Redundancy
```

Signal types:
- `topic_shift` - topic changed (keyword analysis)
- `redundancy_detected` - duplicate content (content hashing)
- `tool_sequence_pattern` - repetitive tools (tool call tracking)
- `context_pressure` - high context usage
- `task_boundary` - explore → implement → verify pattern

## Policy Engine (Declarative Rules)

```typescript
{
  id: "high-usage-aggressive",
  trigger: { type: "context_usage", threshold: 85 },
  action: { type: "compact", level: "aggressive" }
}
// Auto-compacts - no approval needed
```

```typescript
{
  id: "pressure-proposal",
  trigger: { type: "context_usage", threshold: 60 },
  action: { type: "propose", message: "Context at {percent}%. Consider context_compress." }
}
// Shows proposal to LLM - implicit approval if continued work
```

## Proposal Lifecycle

1. **Detection**: Signal detector finds topic shift/redundancy/pressure
2. **Policy evaluation**: Matching policies fire
3. **Proposal creation**: `createProposal()` → stored as CustomMessageEntry
4. **LLM sees**: `💡 Context Suggestion: Context at 65%. Consider context_compress.`
5. **Implicit approval**: LLM continues work without referencing proposal
6. **Resolution**: After 2+ turns, marked as `implicit_approved`

## File Structure (1,120 lines total)

```
context-lifecycle/
├── types.ts           (239 lines) - Interfaces, proposals, snapshots, policies
├── policy-engine.ts    (99 lines) - Rule evaluation, deduplication, cooldowns
├── signal-detector.ts (259 lines) - Session content analysis, topic detection
└── index.ts          (523 lines) - 2 tools, event hooks, integration
```

## Tools

### `context_proposals`
- `list` - View pending proposals
- `approve <id>` - Approve a proposal
- `reject <id>` - Reject a proposal
- `snapshots` - List available snapshots
- `stats` - S-MMU statistics

### `context_signal`
- `task_boundary` - Emit task boundary signal
- `topic_shift` - Emit topic shift signal

## Default Policies

| Policy | Trigger | Action | Approval |
|--------|---------|--------|----------|
| Light dedup | redundancy ≥ 2 | compact: light | **auto** |
| Aggressive compact | context > 85% | compact: aggressive | **auto** |
| Medium compact | context > 70% | compact: medium | **auto** |
| Pressure proposal | context > 60% | propose | **implicit** |
| Topic shift proposal | topic_shift signal | propose | **implicit** |
| Task boundary proposal | task_boundary signal | propose | **implicit** |
| Auto-snapshot | context_pressure signal | snapshot | **auto** |

## What Was NOT Built (Deliberately)

- **No context_pin/context_hold** - overlap with existing checkpoint tools
- **No context_restore** - overlap with context_checkout
- **No context_lifecycle management tool** - proposals are self-managing via CustomMessageEntry
- **No enforcement state integration** - not accessible from extension
- **No scratchpad state integration** - not accessible from extension

## Key Insight

> The value is in AUTOMATION, not new tools. The existing context_* tools are the interface. The S-MMU layer adds automatic proposals, snapshots, and signal detection - all without new tool calls.
---

## Governance Constraints

| Constraint | Target | Severity | Purpose |
|------------|--------|----------|---------|
| `proposal-spam` | proposal | warn | Max proposals per 10 turns |
| `low-confidence-warning` | proposal | warn | Warn if confidence < 50% |
| `high-usage-safety` | action | **block** | Block aggressive compact if confidence < 80% |

## Closed-Loop Outcome Tracking

Outcomes tracked for each proposal resolution:
- `proposalId` - Unique identifier
- `resolution` - approved/rejected/implicit_approved/expired
- `turnsToResolve` - How many turns until resolved
- `timestamp` - When resolved

Stats show: approval rate, avg turns to resolve, action taken rate.

## TTL/Eviction (Sub-linear Growth)

- **Outcomes**: Sliding window of 100, TTL 30 minutes
- **Snapshots**: TTL 24 hours (configurable)
- **Proposals**: Auto-expire after 2 turns (implicit approval)

## File Structure (1,310 lines)

```
context-lifecycle/
├── types.ts (360L)      - Policies, governance, proposals, snapshots, outcomes
├── policy-engine.ts (187L) - EvaluatedAction with validation
├── signal-detector.ts (259L) - Topic detection, redundancy, tool patterns
└── index.ts (504L)     - R-CCAM loop, tools, outcome tracking, eviction
```

