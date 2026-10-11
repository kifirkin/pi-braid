---
name: placement-discipline
description: "The operational workflow around placement discipline: name the layer before building, keep domain facts out of shared layers (a fix lives where the invariant lives), carry the required ## Placement section in impl/audit/verify reports, append repairs to the placement ledger, and tamper-test the checker before trusting a green run. Use when planning or reviewing any change that touches a shared or generic layer, when writing a report, or when validating a worker's result."
validated: 2026-09-15
verdict: UNVALIDATED
---

## trigger: "placement, wrong layer, generic layer, domain fact in shared code, ## Placement section, placement ledger, tamper test, validating a worker result"

# Placement Discipline

A fix lives where the invariant lives: shared layers know mechanisms, never one project's names, paths, or policy. When a change would teach a generic layer a domain fact, the design is wrong - stop and move the mechanism, do not patch around it.

---

## At Brief Time

Every brief names the layer the change lives in. If the brief does not, get the layer named before building. The naming forces the one question that decides the design: is this a mechanism (shared layer) or a policy (domain layer or config)?

---

## The Decision Test

Before writing the fix, answer: would this change teach a shared layer a project's name, path, role, or policy?

- Yes: the mechanism is wrong or incomplete. Options, in order: (1) the shared layer takes the fact from configuration or data at runtime; (2) the fact moves to the domain layer that owns it; (3) a new generic mechanism is added and the fact becomes its input.
- The shapes to refuse: a domain fact as a constant in shared code, a home-path or cwd gate in a generic module, a role word compiled into classification, a skill or feature list snapshot in a shared layer.
- The correct shape looks boring: one mechanism, config-supplied values, no project vocabulary in the code. "Core never learns the project's name" is the test a reviewer can run with grep.

---

## In the Report

Every impl, audit, and verify report carries a `## Placement` section with three parts:

- **Layer changed** - where the change lives, and why that is the invariant's home
- **Domain literals added to generic layers** - list them, or write "none"
- **What remains unverified** - the honest remainder

`check-result.mjs` (orchestrator scripts) enforces the section: a result with spec impl, audit, or verify whose output file lacks a `## Placement` heading fails validation, the same class as a false done. The section is the hook that makes wrong-layer fixes findable later; write it as a claim a grep can check.

---

## The Ledger

Placement leaks and their repairs go one row per instance into `braid-docs/research/PLACEMENT-LEDGER.md` (append-only): date, wave or task, layer, class, fix, status. The periodic audit (`misdirection-audit` skill) reads this ledger; recurrence of a class is the signal to promote it from "found once" to "gated".

---

## The Tamper-Test Habit

Before trusting a green gate run, prove the gate can fail:

1. Plant a leak: a temporary tracked file containing a known violation (a provenance token in a comment, a home path in a string).
2. Run the strict checker: `npm run check:placement -- --strict`.
3. Expect exit 1 with the planted hit listed by class and file.
4. Remove the plant, re-run, expect exit 0 with the tree clean.

A checker that has never been seen failing may be mis-scoped, excluded, or reading the wrong tree. Tamper-test on first use of any gate, and again whenever its pattern set or exclusion list changes.

---

## Reviewing a Worker's Result

- Run `check-result.mjs <worker-session>`: schema valid, output file exists, `## Placement` present.
- Re-check the claims against evidence: commit exists, gates exit 0, count deltas reproduce.
- Read the Placement section as a claim: does the named layer match the diff? Any domain literal added to a generic layer must be justified there, not discovered later by the audit.

Cross-reference `misdirection-audit` (the periodic audit and promotion rule) and `probe-evaluation` (measuring whether a change causes a behavioral delta).
