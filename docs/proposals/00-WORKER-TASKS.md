# pi-braid Worker Tasks — Priority Queue

**Agent**: Pick items from this queue and implement. Update status after each.
**Location**: `pi-braid/` (research worktree, `worktree/braid-research` branch)

---

## P0: Self-Evolution Loop

**Files**:

- `docs/PROPOSALS/SELF-EVOLUTION-META-COGNITION-PROPOSAL.md` (design)
- `docs/PROPOSALS/SELF-EVOLUTION-RESEARCH-SYNTHESIS.md` (literature)

**Goal**: Closed-loop self-improvement after each task.

**Pipeline to implement**:

```
Task Complete → Verify Success/Failure →
  If success: extract SOP (3-tier hierarchy) → store in procedural memory
  If failure: extract principle → store in belief store
Next task → query SOPs → Coach decides whether to surface
```

**Key papers**: MARS (2601.11974), ACE (2510.04618), Evo-MedAgent (2604.14475)

**Status**: Proposal complete, implementation needed.

---

## P1: Missing Extensions (implement from doc)

| File    | Description                      |
| ------- | -------------------------------- |
| `ux.md` | UX extension doc, no code exists |

---

## P2: Enhancement Proposals (implement from doc)

| File                                          | Description                       |
| --------------------------------------------- | --------------------------------- |
| `agent-timer-pomodoro.md`                     | Pomodoro-style agent pacing       |
| `bidirectional-verifier-proposal.md`          | Forward + backward verification   |
| `contrast-phrase-library.md`                  | Behavioral contrast phrases       |
| `heartbeat-as-event-bus.md`                   | Heartbeat-driven interrupt system |
| `hierarchical-memory-compression-proposal.md` | Three-tier memory compression     |
| `repe-prompt-contrast-proposal.md`            | RepE contrast vectors             |
| `sae-steering-proposal.md`                    | Sparse autoencoder steering       |
| `structured-output-catalyst.md`               | Output optimization               |
| `var-math-variants.md`                        | Mathematical variant generation   |

---

## Implementation Guidelines

1. Create `src/extensions/<name>/index.ts` based on proposal doc
2. Register in `src/modules/definitions.ts`
3. Run `npm run build` to verify TypeScript compiles
4. Create `docs/extensions/<name>.md` if not already exists
5. Update this file's status when complete

---

_Last updated: 2026-04-29_
