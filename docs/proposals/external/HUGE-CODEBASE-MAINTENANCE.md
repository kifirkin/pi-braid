# How Agents Can Maintain Huge Codebases: Research Framework

**Date**: 2026-04-27
**Status**: Early research — 4 concrete sub-problems, no empirical data yet
**Research question**: What architectural primitives does an LLM agent need to maintain a 10M+ line codebase?

---

## The Scale Problem

A 10M line codebase ≈ 200K tokens. The entire Linux kernel is ~30M lines. Enterprise codebases routinely exceed 1M lines. No LLM context window can hold this. No agent can read it all.

The naive approach — "read everything, then make changes" — doesn't scale. The question is: **how does the agent build and maintain a mental model of a codebase it cannot fully hold in context?**

---

## The 4 Sub-Problems

### Sub-Problem 1: Navigation at Scale

**The challenge**: The agent needs to find the right code to modify without reading all the code.

**Current state**: Agents use grep, find, tree. These are syntactic. They find text patterns, not semantic concepts. "Find the authentication module" requires the agent to know what to grep for.

**What actually works at scale**:

| Approach | How it works | Limitation |
|----------|-------------|------------|
| Grep/find | Text pattern matching | Requires knowing the text |
| AST analysis | Parse, extract structure | Can't run on entire 10M lines |
| Semantic search (RAG) | Embed code chunks, query by meaning | Stale unless incrementally updated |
| Hierarchical summaries | Module → File → Function summaries | Needs maintenance |
| Dependency graphs | Call graph, import graph | Often incomplete for large codebases |

**The key insight**: Navigation should be hierarchical, not flat. The agent first narrows to the module, then to the file, then to the function. Each level has a summary that makes the next level searchable.

**Proposed architecture**:
```
User: "fix the memory leak in the auth module"
         ↓
[Module-level semantic search]
→ narrows to: auth/ session/
         ↓
[File-level summary]
→ narrows to: auth/session/token_manager.py
         ↓
[Function-level analysis]
→ identifies: refresh_token() has unbounded cache
         ↓
[Change]
```

**Research questions**:
- How often do summaries need to be updated?
- Can embeddings alone identify the right module, or does the agent need structured metadata?
- What's the precision/recall tradeoff between semantic search and grep?

---

### Sub-Problem 2: Change Impact Prediction

**The challenge**: Before changing code, the agent needs to predict what will break. After changing it, the agent needs to know what to test.

**The naive approach**: Change the code, run all tests, fix what breaks. This works for 100 files but not for 10,000.

**What actually works**:

| Approach | How it works | Limitation |
|----------|-------------|------------|
| Static call graph | Who calls this function? | Misses dynamic calls, reflection, string references |
| Type analysis | What types does this use? | Weak for dynamically typed code |
| Test coverage map | What tests exercise this code? | Many files have no tests |
| Semantic similarity | What is conceptually related? | Expensive to compute at scale |
| Change history | Who changed this recently? | Only works for codebases with history |

**The key insight**: Impact prediction requires a **typed dependency graph** (not just call graph). A type change in a function signature requires finding all callers. A schema change in a data model requires finding all code that serializes/deserializes it.

**Proposed architecture**:
```
Agent proposes: rename `user_id` to `account_id` in User model
         ↓
[Dependency tracer]
→ finds all references: User model, serializer, deserializer, API routes, tests
→ classifies by impact: type-1 (must update), type-2 (may break), type-3 (comment)
         ↓
[Change planner]
→ generates ordered change list: model first, then consumers
→ generates test subset: run auth tests + user tests, not payment tests
         ↓
[Change executor]
→ applies changes in dependency order
```

**Research questions**:
- How accurate are static call graphs for dynamically-typed code (Python, JS)?
- Can the agent learn a "sensitivity score" per file from test failure history?
- What's the minimum graph that's sufficient for accurate impact prediction?

---

### Sub-Problem 3: Atomic Multi-File Changes

**The challenge**: Refactoring across 500 files must be atomic. If 499 succeed and 1 fails, you have a broken codebase. The agent needs to change all or none.

**Current tools**: Git branches provide atomicity at the commit level. But the agent needs:
1. Pre-flight validation (can this change even work?)
2. Ordered application (change dependencies before dependents)
3. Rollback on failure
4. Verification (did the change actually fix the problem?)

**RefAgent's approach** (2511.03153): Multi-agent loop with tester as gatekeeper. Each refactoring step runs tests before proceeding. Self-reflection triggers retry.

**The Stal architecture** (2026): GitManager provides branch/create/commit/revert. Branch before any change. Multi-file orchestrator applies changes, tests, then commits atomically.

**Proposed architecture**:
```
Refactoring goal: extract PaymentProcessor from monolith
         ↓
[Impact analysis]
→ identifies 47 affected files across 3 packages
         ↓
[Change planner]
→ generates ordered batch: (1) create new package, (2) copy code, (3) update imports, (4) run tests
→ creates Git branch: refactor/payment-processor-extraction
         ↓
[Batch executor]
→ applies changes in order
→ runs targeted test suite after each step
→ on failure: git revert, analyze failure, retry
         ↓
[Verification]
→ runs full integration test
→ on success: git merge, delete branch
```

**The hard part**: Knowing when to stop. Refactoring can touch an infinite surface area. The agent needs a clear definition of "done" — not "all tests pass" but "the original design goal is achieved."

**Research questions**:
- How does the agent know when refactoring is complete vs. when it's creating new debt?
- What's the right granularity for atomic changes? One file at a time? One module?
- Can the agent detect when a refactoring is making things worse (adding layers, increasing coupling)?

---

### Sub-Problem 4: Model Freshness

**The challenge**: The agent's mental model of the codebase (summaries, embeddings, dependency graphs) becomes stale every time the code changes. For a codebase with 100 commits/day, the model is stale within hours.

**Current approaches**:
- Full rebuild: Regenerate everything after each change. Expensive but correct.
- Lazy evaluation: Build model on demand, cache results. Fast but may miss dependencies.
- Incremental update: Update only affected parts of the model. Complicated but necessary at scale.

**The key insight**: The agent doesn't need a perfect model. It needs a model that's good enough to navigate correctly. The question is: what's the minimum freshness for each model component?

| Model component | Freshness needed | Update trigger |
|---------------|-----------------|----------------|
| Module-level summaries | Daily | File added/removed |
| File-level summaries | Hourly | Significant change |
| Function summaries | Per-session | Modified function |
| Dependency graph | Minutes | Import/function call change |
| Test coverage map | Per-build | Tests added/modified |

**Proposed architecture**:
```
[File change event]
         ↓
[Dirty tracker]
→ marks affected module summary as dirty
→ marks affected file summary as dirty
→ marks dependency graph edges as dirty
         ↓
[Background updater]
→ updates dirty components in priority order
→ rate-limited to avoid overwhelming the system
         ↓
[Query time]
→ if summary is fresh enough, use it
→ if not, build on-demand (with warning)
```

**Research questions**:
- What's the minimum freshness for each model component to maintain navigation accuracy?
- Can embeddings be incrementally updated, or do they need full recomputation?
- How does the agent detect when its model is stale (without re-reading the code)?

---

## Integrated Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                      AGENT ORCHESTRATOR                         │
│   plan → act → observe → reflect → adapt                         │
└──────────────────────────┬──────────────────────────────────────┘
                           │
        ┌──────────────────┼──────────────────┐
        ▼                  ▼                  ▼
┌───────────────┐  ┌───────────────┐  ┌─────────────────┐
│   NAVIGATOR   │  │   CHANGER     │  │   VERIFIER      │
│               │  │               │  │                 │
│ Semantic index│  │ Dependency    │  │ Test runner     │
│ Module summaries│  │ graph        │  │ Test selector   │
│ File summaries │  │ Change planner│  │ Failure analyzer│
│ Call graph    │  │ Batch executor │  │ Rollback manager│
└───────┬───────┘  └───────┬───────┘  └────────┬────────┘
        │                  │                    │
        └──────────────────┼────────────────────┘
                           ▼
              ┌─────────────────────────┐
              │      MODEL STORE       │
              │  (dependency graph,    │
              │   embeddings,         │
              │   summaries,           │
              │   coverage map)        │
              └─────────────────────────┘
```

---

## The Compliance Theater Problem (From Our Research)

Here's where our implicit framing work connects directly:

**"You MUST maintain clean code" → compliance code theater**

An agent given a directive like "keep the codebase clean" will produce clean-looking behavior:
- Remove obvious dead code
- Add docstrings
- Format code

But it won't catch:
- Conceptual duplication (two modules doing the same thing differently)
- Integration gaps (extension registered but never wired)
- Architectural debt (the patterns that will cause problems in 6 months)

**What works instead**: Identity framing.
- "You are an architect who maintains structural integrity"
- "You are a systems thinker who considers how changes propagate"

This is an empirically testable hypothesis: does identity framing produce better architecture maintenance than directive framing?

**Proposed experiment**:
```
Condition A: "You MUST remove dead code, update tests, maintain documentation"
Condition B: "You are a software architect who values simplicity and cohesion"

Measure:
- Dead code ratio over time
- Test coverage over time  
- Coupling metrics over time
- Agent time spent on maintenance vs. feature work
```

---

## Open Questions

1. **Can an agent maintain its own architecture?** The recursive problem: to refactor the refactoring agent, the agent needs to reason about its own reasoning code. Is this solvable or does it require human intervention at some depth?

2. **How does the agent know when it's done?** Feature work has acceptance criteria. Architecture maintenance doesn't. When is a refactoring "complete"?

3. **When should the agent refactor vs. accept debt?** Some debt is strategic. Refactoring prematurely wastes time. Refactoring too late makes changes harder. What's the heuristic?

4. **How does the agent handle conflicting changes?** Two developers want opposite refactorings. The agent needs to detect conflicts and escalate or negotiate.

5. **Can the agent measure its own effectiveness?** If the agent maintained the codebase for a month, how much debt did it reduce? What would have happened without it?

---

## pi-braid as a Testbed

pi-braid's own codebase (33K lines, 120 files) is small but complex enough to test these ideas:

| Sub-problem | pi-braid test |
|-------------|--------------|
| Navigation | Build semantic index of extensions. Query: "which extension handles memory?" |
| Impact prediction | Before changing `enforcement/index.ts`, predict what breaks |
| Atomic changes | Refactor topic-drift unification as atomic multi-file change |
| Model freshness | Track how stale the index gets after 10 commits |

---

## Papers to Cite

| Source | Key contribution |
|--------|-----------------|
| RefAgent (2511.03153) | Multi-agent self-reflection loop for refactoring |
| Stal (2026) | Git safety, RAG for code, AST analysis |
| RepoAI (2026) | Multi-agent orchestration for cross-file changes |
| VAR-MATH (2507.12885) | Benchmark contamination — agents may "solve" maintenance by memorizing patterns |
| Our work | Compliance code theater — directive framing produces clean-looking code, not clean code |

---

*Research by Braid — 2026-04-27*
*Connects to: RefAgent, implicit framing, pi-braid architecture audit*
