---
name: openspec
description: "Write structured specs (spec.md with SHALL/MUST/SHOULD, Given/When/Then scenarios), create changes as proposal/specs/design/tasks folders, use delta specs (ADDED/MODIFIED/REMOVED), and verify implementation against specs. Use when: writing requirements, proposing changes, designing features, defining acceptance criteria, or planning implementation work."
---

# OpenSpec Integration

Spec-driven development (SDD) for pi-braid agents — structured specs, delta-based change tracking, and bidirectional verification.

---

## Core Concepts

### Specs Are Behavior Contracts, Not Implementation Plans

A **spec** describes what the system does (observable behavior), not how it does it (implementation):

| Belongs in spec.md | Stays out of spec.md |
|---|---|
| Observable behavior users rely on | Internal class/function names |
| Inputs, outputs, error conditions | Library or framework choices |
| Security, privacy, reliability constraints | Step-by-step implementation |
| Testable scenarios (Given/When/Then) | Detailed execution plans |

### Three Sections

```
README.md
        ├── docs/
        ├── src/
        └── skills/
```

A spec file has these sections:

```
# <Domain> Specification

## Purpose
High-level description of this spec's domain.

## Requirements

### <Req Name>
The system SHALL <behavior>.

#### Scenario: <title>
- GIVEN <context>
- WHEN <action>
- THEN <expected outcome>
- AND <additional outcome>

### <Another Req>
The system MUST <behavior>.

#### Scenario: <title>
- GIVEN <context>
- WHEN <action>
- THEN <expected outcome>
```

### RFC 2119 Keywords

| Keyword | Meaning |
|---|---|
| **MUST** / **SHALL** | Absolute requirement |
| **SHOULD** | Recommended, exceptions exist |
| **MAY** | Optional |

---

## Delta Specs

For changes to an existing system, write **delta specs** — they describe only what's changing:

```
# Delta for <Domain>

## ADDED Requirements

### Requirement: <Feature>
The system SHALL <new behavior>.

#### Scenario: <title>
- GIVEN <context>
- WHEN <action>
- THEN <expected outcome>

## MODIFIED Requirements

### Requirement: <Existing Feature>
The system MUST <changed behavior>.
(Previously: <old behavior>)

#### Scenario: <title>
- GIVEN <context>
- WHEN <action>
- THEN <expected outcome>

## REMOVED Requirements

### Requirement: <Deprecated Feature>
(Reason for removal.)
```

Sections on archive:

| Section | Archive Action |
|---|---|
| `ADDED` | Appended to main spec |
| `MODIFIED` | Replaces existing requirement |
| `REMOVED` | Deleted from main spec |

---

## Change Folder Structure

Every proposed modification gets its own folder:

```
openspec/changes/<change-name>/
├── proposal.md        # Why + scope + approach
├── design.md          # Technical architecture + decisions
├── tasks.md           # Implementation checklist
└── specs/             # Delta specs
    └── <domain>/
        └── spec.md
```

### Artifact Flow

```
proposal ────► specs ────► design ────► tasks ────► implement
    │            │            │            │
   why          what         how         steps
 + scope      changes      approach    to take
```

### Proposal (proposal.md)

```
# Proposal: <Title>

## Intent
<What problem this solves and why it matters>

## Scope
In scope:
- <item 1>
- <item 2>

Out of scope:
- <item 1>

## Approach
<High-level technical strategy>
```

### Design (design.md)

```
# Design: <Title>

## Technical Approach
<Architecture overview>

## Architecture Decisions

### Decision: <Name>
Using <approach> because:
- <reason 1>
- <reason 2>

## Data Flow
<Diagrams or flow description>

## File Changes
- `src/path/to/file.ts` (new/modified)
```

### Tasks (tasks.md)

```
# Tasks

## 1. <Group Name>
- [ ] 1.1 <Task>
- [ ] 1.2 <Task>

## 2. <Group Name>
- [ ] 2.1 <Task>
- [ ] 2.2 <Task>
```

---

## Integration with pi-braid

### Bidirectional Verification

The structured spec format feeds directly into pi-braid's `bidirectional-verifier.ts`:

```
spec.md (SHALL/MUST + scenarios)
    │
    ▼
bidirectional-verifier.ts
    │
    ▼
Checks: implementation matches spec
    1. All requirements covered?
    2. All scenarios tested?
    3. Error states handled?
    4. Design decisions reflected in code?
```

When verifying against OpenSpec specs, check:

- Every `SHALL` / `MUST` requirement has a corresponding implementation path
- Every `Scenario` (Given/When/Then) is testable
- `ADDED` sections map to new code
- `MODIFIED` sections map to changed code
- `REMOVED` sections have no lingering references

### Workflow Commands

When a human says they want to implement something, use this pattern:

1. **Propose** — Write `proposal.md` clarifying intent, scope, approach
2. **Spec** — Write delta specs in `specs/<domain>/spec.md`
3. **Design** — Write `design.md` with technical approach
4. **Tasks** — Write `tasks.md` with numbered checklist
5. **Implement** — Work through tasks, check them off
6. **Verify** — Run bidirectional verification against specs
7. **Archive** — Merge delta specs into main specs, move change folder to `archive/`

### Archive

When a change is complete:

```
Before:
openspec/changes/<name>/specs/<domain>/spec.md  (delta)
openspec/specs/<domain>/spec.md                 (main)

After:
openspec/changes/archive/<date>-<name>/specs/... (preserved)
openspec/specs/<domain>/spec.md                  (updated with deltas merged)
```

---

## Workflow Selection

| Situation | Process |
|---|---|
| Clear requirements, simple change | proposal → design → tasks → implement (skip specs) |
| Complex behavioral change | proposal → specs → design → tasks → implement → verify |
| Bug fix, minimal scope | proposal → tasks → implement |
| Exploratory / unclear requirements | research → proposal → specs → design → tasks → implement |
| Parallel streams | Multiple change folders, implement one at a time |

**Rule of thumb**: If you can't write a clear `proposal.md`, you need more exploration first. If you can't write the spec, you don't understand the behavior well enough to implement.

---

## Examples

### Minimal (bug fix)

```markdown
# Proposal: Fix login redirect loop

## Intent
Users get stuck in a redirect loop when their session expires
during checkout.

## Approach
Check for existing redirect parameter before appending.
```

```
# Tasks

## 1. Fix redirect logic
- [ ] 1.1 Add redirect-exists check in auth middleware
- [ ] 1.2 Write test for redirect loop scenario
```

### Full (feature change)

```markdown
# Proposal: Add tool approval enforcement

## Intent
Prevent agents from executing high-risk tools without explicit
human approval. Currently all tools execute immediately.

## Scope
In scope:
- Define high-risk tool categories
- Pre-execution approval hook
- Timeout for pending approvals

Out of scope:
- Approval UI (in-terminal prompt only)
- Audit log for approvals
```

```markdown
# Delta for Enforcement

## ADDED Requirements

### Requirement: Tool Risk Classification
The system SHALL classify each tool as low-risk or high-risk.

#### Scenario: Low-risk tool
- GIVEN a tool registered as low-risk
- WHEN the agent invokes the tool
- THEN the tool executes immediately without approval

#### Scenario: High-risk tool
- GIVEN a tool registered as high-risk
- WHEN the agent invokes the tool
- THEN execution pauses
- AND the human is prompted for approval
- AND the tool executes only on explicit approval

## REMOVED Requirements

### Requirement: Immediate Execution
(Replaced by risk-based approval. All tools now pass through
classification before execution.)
```
