# Agent Codebase Maintenance: Research Synthesis

**Date**: 2026-04-27
**Research question**: How do LLM agents maintain large codebases — and how should pi-braid's own architecture be maintained?

---

## The Gap

The implicit framing research identified **compliance theater** in prompts: code that satisfies the build but doesn't produce behavioral change. pi-braid has the same pattern at the **architecture level** — extensions that exist, tests that pass, but no behavioral integration.

More broadly: the literature on LLM agent codebase maintenance is sparse. Most papers focus on agents refactoring _other_ codebases. Almost none study how agents maintain their _own_ architecture over time.

---

## Literature Found

### RefAgent (2511.03153) — Multi-Agent Refactoring

**What it is**: Multi-agent framework for end-to-end software refactoring. Four specialized agents: planner, executor, tester, reviewer. Iterative self-reflection loop.

**Key findings**:

- Multi-agent (4 specialized agents) outperforms single-agent by 64.7% on unit test pass rate
- Achieves 90% unit test pass rate, 52.5% code smell reduction
- F1-score of 79.15% on identifying refactoring opportunities (vs. developer refactorings)
- Self-reflection is critical: each agent refines based on test results

**Architecture**:

```
Planner Agent → Executor Agent → Tester Agent → Reviewer Agent
       ↑                                              ↓
       ←←←←←←←← self-reflection loop ←←←←←←←←←←←←←←←←←←
```

**What it doesn't cover**: How to decide WHAT to refactor vs. what to leave. No hierarchy of debt. No agent self-maintenance.

---

### Stal Blog Post (2026) — Single/Multi-File Refactoring Agent

**What it is**: Practical guide to building a refactoring agent. Covers AST-based analysis, RAG for large codebases, Git versioning for safety.

**Key architectural components**:

1. **Orchestrator** — plan/act/observe loop
2. **Code Analyzer** — AST parsing, static analysis
3. **Git Manager** — versioning, rollback safety
4. **Knowledge Base** — RAG/embeddings for semantic search
5. **File Handler** — read/write with rollback

**Key insight on context management**:

- Summarization (condense large files)
- RAG (vector DB for semantic retrieval)
- Sliding window (process in chunks)
- Explicit tool calling (agent asks for specific files)

**What it doesn't cover**: Agent's own architecture decay. How to know when YOUR OWN extensions are obsolete.

---

### RepoAI (ScienceDirect) — Multi-Agent Orchestration

**What it is**: Multi-agent system for repository-level refactoring. Coordinated LLM orchestration with cross-family validation.

**Key**: agents coordinate across files, not just within files.

---

## The pi-braid Specific Problem

### Architecture Decay Patterns We Identified

1. **Build-then-forget**: Extension is built, tests pass, integration never happens
2. **Conceptual duplication**: 3 topic-drift implementations (lib class + cognitive extension + enforcement state)
3. **Zero-importer files**: `goal-manager.ts`, `br1-self-reflection.ts`, `compression-strategy.ts` — nothing imports them
4. **Overly complex primitives**: `planner.ts` (403 lines) defines a Plan/PlanStep type system that nothing uses
5. **Unused stores**: `three-memory-stores` works, but the agent never auto-recalls from it

### Why This Happens

LLM agents are **notoriously bad at maintenance tasks**. They prefer building new things over cleaning old things. The implicit framing research shows why: "You MUST clean up" triggers compliance theater (produce cleanup-looking behavior) rather than actual cleanup.

The same applies to architecture:

- "Add this extension" → visible, testable, rewardable
- "Remove this dead code" → invisible, no test coverage, uncertain impact

---

## The Research Question: Agent Self-Maintenance

**Core question**: Can an LLM agent maintain its own architecture without human intervention?

This is different from "agent refactors external codebases" because:

1. **Recursive problem**: An agent maintaining its own architecture needs to reason about code that includes its own reasoning
2. **Ownership**: No external stakeholder to validate the refactoring
3. **Test coverage**: The agent's own tests may be part of what needs maintenance

### Proposed Approach: Compliance Theater Detection for Architecture

Apply the same methodology from implicit framing research to architecture:

| Prompt Pattern                                             | Architectural Equivalent                                        |
| ---------------------------------------------------------- | --------------------------------------------------------------- |
| "You MUST write tests"                                     | "You MUST remove dead code"                                     |
| Compliance theater: writes tests that don't cover anything | Compliance cleanup: removes code that nothing uses              |
| Behavioral filter: "You are a careful engineer"            | Behavioral filter: "You are an architect who values simplicity" |

**Hypothesis**: Architecture compliance theater is harder to detect than prompt compliance theater because:

- Dead code can look active (imported, referenced)
- Active code can look dead (only one caller)
- Test coverage masks integration gaps

### Measuring Architecture Debt

| Metric                       | How to Measure                                  |
| ---------------------------- | ----------------------------------------------- |
| Dead imports                 | Static analysis: exported but never imported    |
| Conceptual duplication       | AST similarity across files                     |
| Integration gaps             | Event listener registration vs. actual emission |
| Token waste in prompts       | Token count of disabled extensions              |
| Test coverage of integration | Does extension X's integration path have tests? |

---

## What pi-braid Actually Needs

Rather than building more infrastructure, pi-braid needs:

1. **Extension lifecycle policy**: Every extension must declare its integration point. If nothing emits the event it listens to, it's dead.

2. **Dead code detection**: Run weekly: `grep -r "export " src/lib/` vs `grep -r "import.*from.*lib/" src/extensions/`. Anything exported but not imported = candidate for archive.

3. **Compliance test for architecture**: A meta-test that verifies every registered extension is actually loaded and used in a real agent session.

4. **Simplicity reward signal**: The agent should be rewarded for reducing extensions, not adding them.

---

## Proposed Research Thread

**Thread name**: `architecture-maintenance`
**Location**: `docs/research/agent-architecture/`

**Experiments**:

1. **Audit pi-braid**: Find all dead imports, conceptual duplications, unused stores
2. **Measure integration coverage**: What percentage of extensions have tests that exercise their integration path?
3. **Agent self-cleanup experiment**: Can pi-braid clean its own dead code when asked? Compare "You MUST remove dead code" vs "You are an architect who values simplicity"
4. **Lifecycle policy**: Implement extension lifecycle metadata (integration point, dependency, deprecation target)

---

## Key Papers

| arXiv      | Paper                                            | Application                                             |
| ---------- | ------------------------------------------------ | ------------------------------------------------------- |
| 2511.03153 | RefAgent: Multi-Agent Refactoring                | Multi-agent self-reflection for refactoring             |
| Stal 2026  | Building an LLM-Based Agent for Code Refactoring | Practical architecture: orchestrator, tools, Git safety |
| (pending)  | Agent codebase self-maintenance                  | Research gap                                            |

---

## Immediate pi-braid Actions

1. Run dead-import audit (grep-based, 10 minutes)
2. Archive zero-importer lib files with proper deprecation notice
3. Unify 3 topic-drift implementations
4. Add integration test for each cognitive extension
5. Add "extension lifecycle" field to `definitions.ts`

---

_Synthesized by Braid — 2026-04-27_
_Literature: RefAgent (2511.03153), Stal blog (2026), RepoAI_
