---
name: software-engineer
description: "Always read this skill when working on software tasks. Universal protocol: analyze > decompose > execute > verify > repeat. DEBUGGING: understand > trace > root cause > fix > verify > repeat"
---

## PROTOCOL

**Analyze** → Identify domains, load relevant sections
**Decompose** → Create todos (1-4h each), claim first, present plan
**Execute** → Implement, test, mark done
**Verify** → Run peer-review checklist before `done`

## DOMAIN TRIGGERS

| If Task Involves | Read Section |
|------------------|--------------|
| >3 steps / >2 files | PROJECT TRACKING |
| Architecture / Refactoring | DESIGN PRINCIPLES |
| New classes / modules | DESIGN PATTERNS |
| Code smells / Duplication | CODE QUALITY |
| Debugging / Logging | DEBUGGING |
| UI / Frontend | INCLUSIVE DESIGN |
| Git / Commits / Releases | GIT HYGIENE |
| Security / Auth / Secrets | SECURITY |
| Database / API design | DATA PERSISTENCE |

---

## PROJECT TRACKING

- Create todos before implementing (use `plan_create`)
- Title: action-oriented; Body: acceptance criteria
- One task at a time; mark `done` only after verification

## DESIGN PRINCIPLES

**SOLID:**
- **S**ingle Responsibility: One reason to change per class/module
- **O**pen/Closed: Open for extension, closed for modification
- **L**iskov Substitution: Subtypes usable wherever base type expected
- **I**nterface Segregation: Many specific interfaces > one general
- **D**ependency Inversion: Depend on abstractions, not concretions

**GRASP:**
- High cohesion, low coupling
- Information expert: assign responsibility to class with the data
- Composition over Inheritance: Prefer has-a over is-a

**Fundamentals:**
- **DRY:** Duplication → extract → reuse
- **KISS:** Simplest solution that works
- **YAGNI:** Don't add unused abstractions

## DESIGN PATTERNS

**Creational:**
| Pattern | Use When |
|---------|----------|
| Factory | Creation logic complex or varies |
| Builder | Many optional parameters |

**Structural:**
| Pattern | Use When |
|---------|----------|
| Adapter | Interface mismatch between components |
| Decorator | Add behavior without modifying class |
| Facade | Simplify complex subsystem interface |

**Behavioral:**
| Pattern | Use When |
|---------|----------|
| Strategy | Multiple algorithms for same task |
| Observer | State changes need multiple listeners |
| Command | Encapsulate requests as objects |
| State | Object behavior changes with state |

## CODE QUALITY

**Smells:**
- Long method/class (>50 lines/>200 lines)
- Many parameters (>3)
- Deep nesting (>3 levels)
- Duplicate code blocks
- Dead code, commented code
- Magic numbers/strings
- Feature envy (method uses other class more than own)

**Refactor:**
- Extract method/class
- Introduce parameter object
- Replace conditional with polymorphism
- Move method to where data lives
- Inline temporary variable

## PEER REVIEW

**Functional:** Runs with real inputs, edge cases tested
**Quality:** Methods <50 lines, no duplication, readable in 5min
**Security:** Input validated, no secrets, deps scanned
**Self-Critique:** List 3+ concerns; address before complete
**Final:** No TODOs, temp files removed, docs updated

## DEVELOPMENT PRACTICES

**Hierarchy:** Bash (<20 lines) → Shell script → Node/TS
**Tests:** Exit flags (`vitest run`, `jest --ci`), never watch mode
**Structure:** One file = one responsibility, max ~200 lines

## GIT HYGIENE

**Format:** `type(scope): subject` (feat, fix, docs, refactor, test, chore)
**Rules:** Subject <50 chars, imperative mood
**Before Push:** Tests pass, self-review done

## DEBUGGING

### Protocol (follow before fixing)

1. **Understand** — Read test/error output. What is EXPECTED? What is ACTUAL?
2. **Run tests** — See the actual error message and stack trace
3. **Trace** — Read the file in the stack trace. Only read other files if needed.
4. **Hypothesize** — Call `hypothesize()` to generate 2+ hypotheses from DIFFERENT files
5. **Fix** — Minimal change that addresses ROOT CAUSE, not symptom
6. **Test** — Run tests to confirm fix works and doesn't break anything

### Required tool calls

- `think()` BEFORE any edit — record observation, decision, reason
- `hypothesize()` for bugs — generate 2+ hypotheses about ROOT CAUSES
- Run tests AFTER every fix

### Speed (invest in understanding)

- Read test FIRST to understand expected behavior
- Read buggy file ONCE
- If more files need reading to understand the FULL problem, READ THEM
- Fix ALL bugs in ONE edit
- Run tests ONCE to verify
- Done

### Key questions

- Is the bug in code that SHOWS the symptom or code that CAUSES it?
- Are there other places with the SAME bug pattern?
- Does it happen in ALL execution paths or just some?
- Is this a type mismatch, scope issue, wrong order, or missing step?

### Common bug patterns

| Pattern | Fix |
|---------|-----|
| Linked list/chain | Link BEFORE advancing pointer. Don't self-reference |
| Thread safety | Wrap shared state access in locks. Move operations inside lock |
| Resource leaks | Clear collections after closing. Close file descriptors |
| Error handling | Preserve original error as `cause`. Chain all errors |
| None vs missing | Track if key was found vs value is None |
| Circular references | Track visited nodes. Skip parent references |
| State machines | Validate transitions. Handle terminal states |

### Common mistakes

- Fixing FIRST bug found without checking if it's THE bug
- Not understanding parallel/concurrent execution
- Not tracing config propagation across modules
- Not running tests after fixing
- Reading too many files when stack trace points to location
- Multiple small edits when one would suffice

## INCLUSIVE DESIGN

**WCAG:** Perceivable, Operable, Understandable, Robust
**Checklist:** Alt text, keyboard nav, focus visible, contrast 4.5:1, labels linked

## SECURITY

**Checklist:** Input validated, auth verified, no secrets, HTTPS, least privilege
**OWASP:** Injection (parameterize), XSS (encode), Broken Auth (MFA)

## DATA PERSISTENCE

**Schema:** Normalize, appropriate types, indexes, foreign keys
**Migrations:** Versioned, reversible, test rollback
**Queries:** Parameterized, SELECT only needed, EXPLAIN first
