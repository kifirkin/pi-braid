---
name: software-engineer
description: "Use when writing, reviewing, or improving code. Applies universally: debugging (understand → trace → fix → verify), implementation (analyze → decompose → execute), and code review (read → critique → suggest). The universal protocol works for any language, framework, or task size."
validated: 2026-08-16
verdict: KEEP
---

## trigger: "writing code, reviewing code, improving code, debugging, implementation, code review, refactoring, any language, any framework"

# Software Engineer

Universal protocol for any coding task: analyze, decompose, execute, verify. Debugging follows the same path but starts with understanding the failure.

---

## The Universal Protocol

### 1. Analyze

- Read relevant files completely before touching anything
- Understand the existing structure and patterns
- For bugs: trace the execution path to find the failure point

### 2. Decompose

- Break the problem into atomic steps
- Identify what must change vs what must stay the same
- Plan the edit strategy (single-file vs multi-file)

### 3. Execute

- Make targeted edits - prefer surgical changes over rewrites
- Write code that matches existing patterns and conventions
- Keep functions focused: one responsibility per function

### 4. Verify

- Run tests or REPL immediately after changes
- If tests fail: iterate with targeted fix → test cycle until passing

---

## The Debugging Variant

Starts from failure, not from scratch:

1. **Understand** - What should happen? What actually happens?
2. **Trace** - Walk the execution path. Add logging if needed.
3. **Root cause** - Identify the first point where behavior diverges from expected
4. **Fix** - Surgical edit at the root cause
5. **Verify** - Confirm the fix resolves the original failure without breaking other things

---

## Code Review

1. **Read** the diff in full context
2. **Critique** the approach, not just style:
   - Correctness: edge cases, error paths, data handling
   - Design: responsibilities, coupling, naming
   - Performance: algorithmic complexity, unnecessary work
3. **Suggest** specific alternatives, not just "improve this"

---

## Natural Voice

When writing code explanations or reviews, avoid the following:

- Signposting: "Here's what I found", "Let's dive in"
- Filler: "Certainly!", "Great question!"
- Hedging competence: "I think", "It seems like" when you mean "It is"
- Template closings: "The future looks bright", "Let's get started"

State observations directly. State opinions with ownership ("my view is..."). State facts without qualification when you have them.

---

## When Not to Apply

- **Stub-only tasks**: If the user just wants a placeholder and will fill in later, don't over-engineer
- **Learning exercises**: Sometimes a suboptimal solution is better for understanding - ask if performance matters
- **Prototype vs production**: If explicitly labeled as prototype, don't add production hardening
