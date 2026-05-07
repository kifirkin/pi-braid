# Research: Memory Leak Prevention & the Implicit/Explicit Boundary

**Date**: 2026-04-24 (early morning)  
**Thread**: pi-braid / memory-system / implicit-explicit / leaking-abstraction  
**Key Paper**: HaluMem (2511.03506) — Memory Hallucinations  
**Based on**: User's design observation + HaluMem findings + SimpleMem + MemEvolve + prior memory research

---

## The Core Problem

**You articulated it precisely**:

> *Memories sometimes leak between projects due to automatic implicit memory injection in system prompt.*
>
> *Runtime injection that non-deterministically injects things on every turn is a pain in the ass.*
>
> *We need to clearly distinguish where we should be explicit and where implicit.*

This is a **leaking abstraction** — the memory system's internal state (contaminated by hallucinations) is leaking into the agent's reasoning context, and the agent can't distinguish memory-derived information from context-derived information.

---

## HaluMem (2511.03506): The Definitive Diagnosis

### What HaluMem Found

```
Memory hallucinations occur at THREE operational stages:

1. EXTRACTION: Memory system fabricates or distorts information from context
   → Model misinterprets context → stores distorted version

2. UPDATING: New information corrupts or conflicts with existing memories
   → Memory updates overwrite without conflict resolution
   → Accumulated errors grow over time

3. PROPAGATION: Extraction and updating errors propagate to QA
   → Downstream reasoning is contaminated by upstream memory errors
```

### The Four Hallucination Types

| Type | Description | Example |
|------|-------------|---------|
| **Fabrication** | Made-up facts not from context | "You worked on project X last week" (never happened) |
| **Error** | Incorrect stored facts | "Project X used React" (actually Vue) |
| **Conflict** | Contradictory memories | "Project X is done" AND "Project X is in progress" |
| **Omission** | Forgotten important info | Memory system dropped critical context |

### Why This Causes Cross-Project Leakage

```
Project A session:
  - Extraction: Stores facts about Project A
  - Some facts are FABRICATED or DISTORTED
  - Memory system marks these as "learned"

Project B session (same agent, different project):
  - Retrieval: Memory system retrieves Project A facts
  - AGENT CAN'T DISTINGUISH: "Is this from current context or from memory?"
  - Agent acts on FABRICATED Project A facts in Project B context
  → CROSS-PROJECT CONTAMINATION
```

The agent treats memory-derived information as ground truth because there's **no provenance tracking**.

---

## The Implicit/Explicit Design Principle

### The Foundational Distinction

```
IMPLICIT: The agent processes it naturally, without awareness
  → Behavioral framing (identity, norms)
  → Domain-fit principles
  → CoT structure (STEP: / RESULT:)
  → These fit naturally, don't break flow

EXPLICIT: The agent and user can see, verify, and reason about
  → Memory injection (must be identifiable as memory, not context)
  → Enforcement triggers (must be visible in TUI)
  → Error context (must be traceable to cause)
  → Tool results (must clearly indicate source, reliability)
```

### Where IMPLICIT Works

| Context | Why Implicit | Example |
|---------|------------|---------|
| **Identity framing** | Behavioral, not informational | "You are a careful engineer" |
| **Norm injection** | Domain-fit principles | "Precision over speed" |
| **Structured format** | Catalyst for ICL (MDA) | `STEP N: / RESULT:` pattern |
| **CoT structure** | Reasoning scaffold, not facts | "Let me think step by step" |
| **Contrast phrases** | Behavioral direction, not content | "Truthfulness over agreeableness" |

These are **BEHAVIORAL** — they shape HOW the agent reasons, not WHAT facts it reasons about.

### Where EXPLICIT Is Required

| Context | Why Explicit | What's Wrong With Implicit |
|---------|------------|-------------------------|
| **Memory injection** | Provenance critical | Agent can't distinguish memory vs. context |
| **Enforcement triggers** | User must know what's happening | "Why did the agent just do X?" |
| **Error context** | Agent must understand cause | "Screenshot saved" is useless; "Screenshot saved to /path (antibot detected)" is useful |
| **Retry signals** | User must see retry reason | "Retrying" is opaque; "Retrying due to 403 (antibot protection)" is clear |
| **Tool failures** | Agent must diagnose | "Failed" is opaque; "Failed: curl 22 (HTTP 403 - antibot protection)" is actionable |
| **Memory boundaries** | Agent must know what's in scope | "MEMORY: [facts from prior sessions]" marks provenance |

### The Key Heuristic

```
IF the injection provides INFORMATION (facts, beliefs, past context):
  → Make it EXPLICIT
  → User and agent can see, verify, and flag provenance

IF the injection shapes BEHAVIOR (framing, norms, reasoning structure):
  → IMPLICIT may work
  → As long as it doesn't corrupt information flow
```

---

## The Memory Contamination Architecture

### The Problem in pi-braid's Current Design

```
Current memory flow (leaking):
  [Session] → [Extract to D0/R5] → [Inject into system prompt]
  → Agent can't tell: "Is this from current context or from memory?"
  → Memory hallucinations propagate to all reasoning

The abstraction is LEAKING: internal memory state → agent context
The agent treats memory-derived as ground truth.
```

### The Fix: Explicit Provenance Layer

```
Memory flow (non-leaking):
  [Session] → [Extract to D0/R5]
  ↓
  [Provenance Tagging] → "MEMORY: [PROJECT: project-id] [SRC: session-id] [TTL: turns-remaining]"
  ↓
  [Inject into system prompt]
  ↓
  Agent CAN distinguish: "This is from memory, marked as project X, might be stale"
  ↓
  [Verification on retrieval] → Agent can choose to verify vs. trust
```

### The Provenance Contract

Every memory injection must carry:

```typescript
interface MemoryProvenance {
  projectId: string;      // Which project this belongs to
  sessionId: string;      // Which session it came from
  extractionTurn: number;   // When it was extracted
  confidence: number;       // 0-1, based on extraction verification
  ttl: number;            // Turns remaining before expiration
  type: 'fact' | 'belief' | 'principle' | 'sop';  // What kind of memory
}
```

### The Three-Level Trust Model

```
LEVEL 1: CONTEXT (highest trust)
  - Directly in current context
  - Agent: "This is from current conversation"
  - No provenance tag needed

LEVEL 2: VERIFIED MEMORY (medium trust)
  - From memory, with high confidence
  - Provenance: [projectId, confidence > 0.8, recent]
  - Agent: "This is from verified memory, can use as context"
  - User can see it in TUI

LEVEL 3: UNVERIFIED MEMORY (low trust)
  - From memory, with low confidence or stale
  - Provenance: [projectId, confidence < 0.8, old]
  - Agent: "This is from unverified memory, verify before acting"
  - User explicitly sees it in TUI

LEVEL 4: EXTERNAL TOOL (highest integrity)
  - From search, code exec, file read
  - Provenance: [tool, timestamp, source]
  - Agent: "This is from external tool, treat as ground truth"
  - Error context explicitly attached
```

---

## SimpleMem's Solution: Semantic Structured Compression

### Why SimpleMem Helps

SimpleMem (2601.02553) proposes a three-stage pipeline that addresses extraction errors:

```
Stage 1: Semantic Structured Compression
  → Distill unstructured interactions into compact, multi-view indexed memory units
  → Each unit has STRUCTURE: what, when, where, source
  → Reduces fabrication by requiring semantic grounding

Stage 2: Online Semantic Synthesis
  → Instantly integrate related context into unified abstract representations
  → Eliminates redundancy before it accumulates
  → Reduces conflict by merging similar memories

Stage 3: Intent-Aware Retrieval Planning
  → Infers search intent to dynamically determine retrieval scope
  → Only retrieves memory relevant to current task
  → Reduces contamination by not retrieving unrelated memories
```

### pi-braid Application

```
D0 BELIEF STORE (Structured):
  - Each belief: { entity, relation, entity, source, confidence, project_scope }
  - Conflict detection before storage
  - Provenance tracking per belief

R5 THREE-MEMORY (Compressed):
  - Working: raw context (Level 1 trust)
  - Episodic: compressed with provenance tags (Level 2/3 trust)
  - Procedural: SOPs extracted and verified (Level 2 trust)
```

---

## The Enforcement/ReTry Signal Pattern

### Your Concrete Change: `display: false` → `display: true`

This is the **perfect example** of choosing explicit over implicit:

```
BEFORE: display: false
  → Enforcement trigger fires, agent acts differently
  → User sees: "Why did the agent suddenly change approach?"
  → User has no visibility into what happened
  → This is IMPLICIT at the WRONG LAYER (runtime behavior)

AFTER: display: true
  → User sees: "[ENFORCEMENT: Reason for trigger]"
  → User understands: "The agent was corrected because X"
  → User has AGENCY: can override or acknowledge
  → This is EXPLICIT where it matters (runtime observability)
```

### The Pattern: Runtime Behavior = Explicit

```
Runtime behavior changes (enforcement, retry, correction) → ALWAYS explicit
  - User must see what happened
  - User must understand why
  - User must have agency to override

Static framing (identity, norms) → Can be implicit
  - User doesn't need to see every behavioral nudge
  - Agent processes naturally
  - Flow is preserved
```

---

## The Tool Error Context Pattern

### Your Insight: Error messages must be actionable

```
BAD: "Screenshot saved"
  → Agent knows WHAT happened but not WHY
  → Agent can't diagnose the root cause

GOOD: "Screenshot saved to /path/to/screenshot.png (HTTP 403 - antibot protection detected on target)"
  → Agent knows WHAT (saved)
  → Agent knows WHERE (/path/to/screenshot.png)
  → Agent knows WHY (antibot protection)
  → Agent knows HOW TO RECOVER (try different approach, use text extraction instead)

This is EXPLICIT at the INFORMATION LAYER:
  - The agent gets actionable context
  - The user can see the reasoning
  - Memory injection of "antibot" knowledge would be IMPLICIT but UNRELIABLE
```

### The Principle: Context Over Condensation

```
Error messages should contain:
  1. WHAT failed (tool name, action)
  2. WHY it failed (root cause, not symptom)
  3. WHERE (file path, URL, location)
  4. HOW TO RECOVER (hint for next step)

This is EXPLICIT CONTEXT INJECTION = better than IMPLICIT memory retrieval
  → The agent learns from the error in context
  → Memory of "antibot causes failures" would be implicit but unreliable
  → Context is trustworthy, memory is suspect
```

---

## Implementation Plan for pi-braid

### Phase 1: Provenance Tagging (Week 1)

```
Day 1-2: Add provenance structure to D0 belief store
  - Each belief: { entity, relation, entity, projectId, sessionId, confidence }
  - Conflict detection on insert
  - TTL per belief

Day 3-4: Tag memory injections in system prompt
  - Format: [MEMORY: project=X, confidence=0.8, ttl=5, type=fact]
  - Distinct visual marker for memory vs. context
  - User sees: "Memory from project X was retrieved"

Day 5: Add to TUI display
  - Show provenance tags in TUI
  - User can see what memory was injected
  - User can flag memory as trusted/untrusted
```

### Phase 2: Memory Boundary Enforcement (Week 2)

```
Day 6-7: Project-scoped memory retrieval
  - Only retrieve memories from current project
  - Cross-project retrieval requires explicit user approval
  - Implement: retrieval scope = current project ID

Day 8-9: Memory TTL enforcement
  - Stale memories auto-expire
  - Confidence decay over time
  - Memory refresh on relevant context

Day 10: Memory contamination detection
  - Track: does retrieved memory match current context?
  - Flag: "Memory may be stale or irrelevant"
  - Signal to agent: "Verify before acting on this"
```

### Phase 3: Enforcement Signal Explicit (Week 3)

```
Day 11-12: Make ALL enforcement triggers visible
  - display: true for all enforcement events
  - Format: "[ENFORCEMENT: reason] [AGENT ACTION: what changed]"
  - User sees the correction in TUI

Day 13-14: Add provenance to enforcement signals
  - "Why was this enforced?" → explainable
  - "What policy was violated?" → traceable
  - "What should agent do differently?" → actionable

Day 15: Error context enrichment
  - All tool failures: root cause + recovery hint
  - Format: [ERROR: root_cause] [RECOVERY: suggested_action]
  - Agent sees context, not just failure
```

### Phase 4: HaluMem Metrics (Week 4)

```
Day 16-17: Implement hallucination detection
  - Track: does memory match retrieved context?
  - Track: are there contradictory memories?
  - Track: are critical facts omitted?

Day 18-19: Memory quality dashboard
  - Fabrication rate per session
  - Conflict rate per project
  - Omission rate (missed relevant context)

Day 20: Validation
  - Before: measure contamination rate
  - After: measure reduction in cross-project leakage
```

---

## The Unified Principle

```
┌─────────────────────────────────────────────────────────────┐
│              EXPLICIT vs IMPLICIT: THE DECISION FRAMEWORK      │
│                                                             │
│  ASK: Does this provide INFORMATION or shape BEHAVIOR?        │
│                                                             │
│  INFORMATION (facts, beliefs, context, memories):             │
│    → ALWAYS EXPLICIT                                        │
│    → Provenance tagging required                             │
│    → User must see, agent must verify                       │
│    → Memory contamination risk if implicit                    │
│                                                             │
│  BEHAVIOR (framing, norms, reasoning structure):            │
│    → CAN BE IMPLICIT (if domain-fit)                        │
│    → No provenance required                                  │
│    → Agent processes naturally                               │
│    → Example: identity, contrast phrases, CoT structure     │
│                                                             │
│  RUNTIME BEHAVIOR CHANGES (enforcement, retry, correction): │
│    → ALWAYS EXPLICIT                                        │
│    → User must see what happened                            │
│    → User must have agency                                  │
│    → Example: display: true, error context, recovery hints  │
└─────────────────────────────────────────────────────────────┘
```

---

## Summary: The Leaking Abstraction Fix

### The Problem

```
Memory system: Extracts → Updates → Retrieves
                    ↓
              Hallucinations accumulate
                    ↓
Memory injection → System prompt (IMPLICIT)
                    ↓
Agent treats as ground truth
                    ↓
Cross-project contamination
```

### The Fix

```
Memory system: Extracts → Provenance Tag → Stores
                           ↓
              [projectId, sessionId, confidence, TTL]
                           ↓
Memory retrieval → Scope enforcement → Explicit injection
                           ↓
              [MEMORY: project=X, confidence=0.8]
                           ↓
Agent sees: "This is from memory, not current context"
Agent can: verify, flag, or trust
```

### The Principle You Already Discovered

Your change of `display: false → true` is the **pattern**:

> Runtime behavior changes = explicit
> Static framing = can be implicit

This extends to memory: **information injection = explicit**, behavioral framing = can be implicit.

---

## Related Papers

| Paper | arXiv | Key Finding |
|-------|-------|-------------|
| HaluMem | 2511.03506 | Memory hallucinations: fabrication, error, conflict, omission. Propagate from extraction/updating to QA. |
| SimpleMem | 2601.02553 | Semantic structured compression + intent-aware retrieval. 30x token reduction, 26.4% F1 improvement. |
| MemEvolve | 2512.18746 | Memory architecture can itself evolve. EvolveLab: encode/store/retrieve/manage design space. |

---

## Status

**Research complete**. Ready to implement once memory system (D0, R5) is wired by parallel agent.

---

*Related: HIERARCHICAL-MEMORY-COMPRESSION-PROPOSAL.md*  
*Related: SELF-EVOLUTION-META-COGNITION-PROPOSAL.md*  
*Related: BENCHMARK-IMPROVEMENTS-PROPOSAL.md (HaluMem metrics)*