---
name: misdirection-audit
description: "Periodic self-audit for misdirected work: run the placement checker, grep generic layers for role/path policy, byte-diff assembled prompts between builds, then classify findings (wrong-layer fix, fake-generic presentation, enforcement gap, unmeasured innovation, doc drift, and more) into one ledger row per instance, where a recurring class earns a gate. Use at wave boundaries, before a release, or when a task asks for a misdirection, placement, or hygiene audit."
validated: 2026-09-15
verdict: UNVALIDATED
---

## trigger: "misdirection audit, placement audit, hygiene sweep, wave boundary audit, audit recent output, periodic self-audit"

# Misdirection Audit

A periodic audit of the project's own recent output for work that went in the wrong direction: fixes in the wrong layer, rules that exist only as prose, metrics that cannot test what they alarm on. Output: classified instances, one ledger row each, and promotion decisions. The audit is read-only on code; it records, it does not fix.

---

## What to Run

Three probes, in order. Record command, exit code, and raw output for each.

1. **Tree provenance scan.** `npm run check:placement -- --strict` at the repo root. Flags provenance tokens (wave/worker/round labels, ISO dates, commit refs) in comments and string literals, role words used as policy in generic layers, and owner home paths anywhere. Exit 0 is clean; every hit is an instance with a file:line.
2. **Domain-literal grep.** Beyond the checker's built-in classes, grep the generic layers for policy that belongs to a domain: role names inside cwd gates or classification logic, hardcoded home-directory roots, project or feature names inside shared mechanism code. The checker's exclusion list documents which paths legitimately own these words; a hit outside the owners is an instance.
3. **Prompt-capture diff.** Capture the assembled prompt from two builds (shipped vs candidate) with `node scripts/prompt-capture.mjs capture --root <dir holding dist> --out <file>`, then `node scripts/prompt-capture.mjs diff <old> <new>`. The root is the directory that holds `dist/`, and that differs by arm: a checkout is `<repo>/packages/core`, while the installed package at `~/.pi/agent/npm/node_modules/pi-braid` carries `dist/` at its own root, so pointing the command at `<installed>/packages/core` exits 2 with ENOENT. Every delta must map to an intended text change; an unintended delta is an instance (unmeasured innovation, or doc drift at the prompt layer). The capture pins every non-code input, so two captures of one build are byte-identical and the only hunks are real; it labels each hunk with the prompt region it belongs to. What it cannot see is listed in its header.

Then read the recent output corpus: reports, briefs, and the git log since the last audit. Admit an instance only with a file:line, message id, or commit ref. "It feels like" is not an instance.

---

## Classification

| Class                          | Signature                                                                                                            |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| wrong-layer fix                | The fix landed in a shared layer and taught it a domain fact (a name, path, or role check in generic code)           |
| fake-generic presentation      | An API or config presents itself as generic while hardcoding one deployment's values                                 |
| write-time enforcement gap     | The rule exists in prompt and docs but loses to precedent because nothing enforces it at write time                  |
| detection-scope lag            | A scan or gate covers one surface only: comments but not strings, staged but not dirty tree, diff but not whole tree |
| research-to-implementation gap | Research identified a defect with a named fix; no change ever shipped                                                |
| unmeasured innovation          | A mechanism, prompt line, or gate shipped with no evaluation hook, adoption counter, or probe                        |
| provenance ambiguity           | Two builds or artifacts share one version or identity; runtime state cannot be asserted from the version line        |
| alarm-on-wrong-window          | A metric alarms over a window containing no post-change data and recommends work the window cannot justify           |
| contract hypocrisy             | A document violates its own stated rule                                                                              |
| duplicate re-litigation        | Repeated efforts re-scope and partially clean the same class instead of gating it once                               |
| doc drift                      | Counts, tables, or claims in governing docs that no longer match the code                                            |

Triage split: intentional surface (documented, owned), accidental coupling (a fact walked into the wrong layer), slop (provenance, narrative, drift). Only the last two are defects.

---

## Where Results Go

One row per instance in the project's placement ledger, append-only: date, task, layer, class, fix, status. No instance without a row; no row without an evidence reference. The ledger is the audit's memory; a fix that leaves no row will be re-discovered, re-scoped, and re-fixed by someone else later.

---

## Promotion Rule

When a class re-appears in the ledger after its first fix, it promotes from "found once" to "gated": a checker class, a brief clause, a report-section requirement, a merge-path scan. Enforcement at write time, not recall. Recurrence in the ledger is the promotion signal; running the same cleanup again without a gate is the failure pattern the ledger exists to end.

---

## Report

- Exit codes and raw output of the three probes
- Instance table: class, evidence (file:line or commit), cost
- New ledger rows, verbatim
- Promotion decisions with the recurrence counts that justify them
- Blind spots: surfaces the audit could not see this pass (excluded paths, out-of-scope doc trees, unversioned workspaces)
