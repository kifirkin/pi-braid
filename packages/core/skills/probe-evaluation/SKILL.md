---
name: probe-evaluation
description: "Design and score a behavioral A/B probe so a null result is informative: pre-registered rubric and decision rule, control-arm sanity, blinded scoring, power and statistics (Wilson intervals, Fisher exact), and the failure catalog for probes that measured nothing. Use when probing whether a prompt, extension, or config change causes a behavioral delta, when extending a probe matrix, or when judging whether a probe's null vetoes or clears a change."
validated: 2026-09-15
verdict: UNVALIDATED
---

## trigger: "behavioral probe, A/B probe, prompt A/B test, probe came back null, scoring probe runs, pre-registered rubric, two-arm comparison"

# Probe Evaluation

A probe answers one question: does arm B (treatment) behave differently from arm A (control)? The ship-gate rule: **no directional delta under the pre-registered decision rule means the change does not ship.** The symmetric rule: a null whose own preconditions failed (control never showed the failure, judge unblinded, N too small) demonstrates nothing in either direction. "No demonstrated benefit" and "demonstrated harm" are different verdicts; never flatten them.

---

## Before the First Run

Fix all four in writing. Nothing is decided after data exists.

1. **Rubric with scored classes.** Every run gets a number from named classes, e.g. 1 = the design puts policy in data read at runtime by a generic mechanism; 0.5 = exactly one side externalized; 0 = policy as a code constant, or a failed run with no design. Decide the ambiguous boundaries (what counts as "externalized") inside the rubric, not during scoring.
2. **Decision rule with numbers.** "B ≥ 3/5 where A ≤ 1/5" is a decision rule; "B looks better" is not. Include the extension clause: when one arm hits its bar at N, whether N extends (e.g. 5 → 10 per arm) and by how much.
3. **Power.** State the detectable lift before running. At N=5 per arm, even 5/5 vs 2/5 is not significant (Fisher two-sided p ≈ 0.17); only near-total separation clears p < 0.05. If the expected effect is smaller than that, raise N in the decision rule or do not run.
4. **Scenario text, verbatim.** Fixed bytes before the first run. If probing whether the subject produces a design unprompted, keep layer-theory vocabulary out of the scenario.

---

## Control-Arm Sanity

The control arm must exhibit the failure the treatment is supposed to fix.

- Before reading anything into an arm delta, check: did arm A score at or below its expected ceiling? If you assumed ≤1/5 layer-correct designs and measured 2/5 or more, the scenario failed to bite. The expected baseline does not exist, so no contrast is possible at this N. Report "scenario failed to bite", not the delta.
- Prime strength cuts both ways: a scenario that hands over the answer (states the conflict, quotes the rule) lifts both arms and measures reading comprehension, not behavior. Pilot on the control arm first; the scenario should force discovery, not recital.
- Text-only runs score designs; live runs with tools score discovery and execution. Different harnesses have different baselines. Never compare across them except as labeled historical context.

---

## Blinding

- Strip arm labels from every run record, shuffle run order, record the map (run id → arm) in a separate file, score blind, then unblind, then compute the contrast.
- The worker who ran the probe scoring its own runs is a disclosed bias, not a control. Dump every raw answer verbatim so a second judge or the parent can re-score blind.
- Count the runs that needed adjudication and report that number. Borderline calls resolve against the rubric's pre-decided boundaries, never toward the expected result.

---

## Arms and Byte Checks

- Two arms, identical harness, one difference: the treatment. Same model, same settings isolation, same timeout, same tool availability. Record the resolved model per run.
- Byte-check the arms before runs: arm A must lack the treatment's new strings and contain the old ones; arm B the inverse. An arm that does not contain its own treatment measures nothing.
- No cherry-picking: a failed run scores 0 and stays in the matrix. Report the sensitivity check (with and without it) if a failed run exists.

---

## Statistics

- Report per-cut counts with **Wilson score intervals** and **Fisher exact (two-sided) p**. Never a bare percentage: 40% at N=5 spans roughly 12% to 77%.
- Each per-run verdict carries a verbatim quote of the decisive feature.
- A non-significant p is absence of demonstrated benefit. Flat-to-negative is not harm. Write the verdict vocabulary exactly: "no directional delta under the pre-registered contrast".

---

## Failure Catalog

How a probe measures nothing. Each row is a found failure mode; several of them compound silently in the same null.

| Failure                       | Signature                                                                            | Prevention                                                                           |
| ----------------------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------ |
| Unblinded single judge        | Scorer knew the arm while scoring; borderline calls drift toward the expected result | Strip labels, shuffle, record the map, score blind, dump raw answers for re-scoring  |
| N too small                   | N=5 per arm, every contrast non-significant                                          | State the detectable lift first; pre-register the extension clause                   |
| Control exceeded its ceiling  | Expected ≤1/5 on the control, measured more; the separation cannot occur             | Control-arm sanity check; rewrite the scenario until the baseline failure reproduces |
| Rubric written after the fact | Classes invented or boundaries loosened once the answers were readable               | Pre-register rubric and boundary definitions; version them with the scenario         |
| Prime strength                | The scenario text supplies the answer, lifting both arms                             | Pilot on the control; make the scenario force discovery                              |
| Harness mismatch              | Text-only probe results compared against a live-session baseline                     | Same harness for arms and baseline, or label the comparison historical context       |
| Single model                  | One model carries the verdict                                                        | Name the model per run; re-probe on other models before generalizing                 |

---

## Report

- Question, arms (commit or config diff), scenario text, rubric, decision rule, N, model
- Per-run table: score, decisive feature, verbatim quote
- Contrast table: counts, Wilson intervals, Fisher p, per cut (base N and extended N)
- Limits: judge blinding, N, harness deviations, prime strength, single model
- Verdict: the pre-registered decision rule applied literally, including the side that failed its bar

Cross-reference `agent-testing` for the RPC harness recipe; `meta-improvement` for the experiment loop around probes.
