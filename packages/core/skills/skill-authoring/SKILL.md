---
name: skill-authoring
description: "Use when a skill has to be written, repaired or retired in this repository: a SKILL.md whose frontmatter a validator refuses, a skill that is never suggested or fires on every prompt, a body nobody follows, or a shipped skill with no read evidence. Produces the file, its trigger phrases and the run that proves both. Not for an ordinary text change or a single tool call fix."
validated: 2026-11-02
verdict: UNVALIDATED
triggers:
  - "create a skill"
  - "new skill"
  - "author a skill"
  - "write a skill.md"
  - "write the skill.md"
  - "skill frontmatter"
  - "trigger phrases"
  - "skill never fires"
  - "skill does not fire"
  - "skill fires on everything"
  - "retire a skill"
---

# Skill Authoring

A skill is two artifacts in one file: a declaration the matcher reads, and a procedure an agent follows. Both halves are machine-checked in this repository, and a file can satisfy one while failing the other. Author against the check, not against the last skill you happened to open.

## Is a skill the right carrier?

Two questions, in order.

1. **Does the situation recur?** A skill is a prediction that this situation will come up again, in another session, with no memory of this one. One-off advice belongs in the session.
2. **Is the knowledge a judgment rule?** If a test, a lint or a type can enforce it, add the check where the invariant lives and say nothing here. A skill that restates an enforceable rule trains agents to treat prose as the requirement; the check is what actually fails.

A skill that answers yes to both is worth its file. A skill that answers no to either is a comment with a frontmatter block.

## Step 1: capture the failing baseline

Run one realistic task without the skill, in a fresh context, and keep what goes wrong word for word. If the run does the right thing, stop: there is nothing to teach, and the file you were about to write would be decoration. The failures are the body's outline and the phrases' vocabulary. One run per claim; a failure nobody observed is a failure you invented.

This is the cheapest gate in the process and the one most often skipped. Its cost is one run. Its value is that every later sentence can point at something an agent actually did.

## Step 2: frontmatter is the interface

Five fields carry weight, and each is read by a different piece of code:

| Field         | Read by                                     | Rule                                                                                                       |
| ------------- | ------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `name`        | the catalog, the matcher, the validator     | equals the directory name; `a-z`, `0-9`, hyphen                                                            |
| `description` | the matcher's keyword leg, the catalog line | one line, at most 1024 chars, and it must name a situation (`Use when ...`); a topic list never fires      |
| `triggers`    | the trigger reader, then the scorer         | at least 2, at most 16 phrases, each at most 66 chars; one phrase names one skill across the installed set |
| `validated`   | readers deciding whether to trust it        | an ISO date, the last time evidence supported the file                                                     |
| `verdict`     | readers deciding what to do next            | one of `KEEP`, `IMPROVE`, `MOVE`, `DEPRECATE`, `UNVALIDATED`                                               |

Four traps follow.

- **The description must not summarize the workflow.** An agent that reads a workflow summary follows the summary and skips the body: a description saying "code review between tasks" produced one review where the body specified two. Conditions only, in the description; the procedure belongs in the body.
- **Keep the description on one line.** The validator reads the first `description:` line and strips quotes, so a `>` folded block is read as the single character `>`, and a description that starts on the next line reads as empty.
- **Declare phrases under `triggers:`, nowhere else.** The reader also accepts a `## trigger:` body heading and a trailing `Triggers:` sentence in the description, but the validator refuses both shapes and counts those files as declaring zero phrases. One format exists; use it.
- **`governs:` is optional and mostly absent.** It names the tool families a body directs, and the admitted families are the pack's own (`browser`, `document`). Advice about prose, a checklist or a file format directs none of them: leave the key out rather than inventing a family.

## Step 3: phrases a user actually types

A phrase is what the user writes when the situation occurs, not a word from the skill's subject. "Skill frontmatter" is a phrase; "skills" is a subject word that appears in every prompt and would fire the skill on unrelated work.

Matching is a case-folded, word-bounded literal test: the phrase occurs where neither neighbour is a letter or digit, so `pane` does not match `paneled`. Four properties follow.

- **A phrase is one wording, not a family of phrasings.** "create a skill" does not occur in "create a new skill", and "write a skill.md" does not occur in "write the SKILL.md frontmatter". Declare the wordings the failing baseline actually used; the articles and the verbs are part of the phrase, and a phrase list that has grown past a dozen entries is usually a list of subject words wearing situation clothes.
- **A phrase hit alone qualifies the skill.** The scorer awards it the weight of a name match and exempts the skill from the qualification bar, so a phrase is the strongest evidence a file can declare and the easiest thing to over-declare.
- **A shared phrase makes the choice a coin flip.** Two skills declaring one phrase are ranked against each other on every matching prompt, and the loser is never suggested. The validator refuses the duplicate by name, which is the rule working as intended.
- **A phrase over 66 characters is silently dropped** by the reader, and the validator refuses the file so the drop never ships. Count characters, do not eyeball them.

## Step 4: the body

- **Mechanism before instruction.** One sentence on why the step exists, then the step. A rule whose reason is on the page survives contact with a case the author did not anticipate.
- **Name the artifact, not the intention.** "Write the row into the ledger" is actionable; "record the decision" is not.
- **Name no tool the reader cannot call.** A skill that names an unreachable tool teaches the agent to invent the missing call, which is worse than teaching nothing. The pack refuses such files by name at validation time; check before you ship.
- **The first 300 characters decide whether the body is read.** The auto-injector carries at most 300 characters of the body in its suggestion and points at the file for the rest. Put the situation and the mechanism at the top; put provenance, history and worked examples below it.
- **Ship a script only when the skill owns the instrument.** Core skills may carry `scripts/`; the standalone pack may not carry code at all. Logic that belongs to an extension lives in the extension, and the skill names the command.

## Step 5: run the gates, in this order

From the repository root:

1. `node packages/skills/test/skills-contract.mjs`: frontmatter, trigger count and length, phrase uniqueness, description situation, and the tool/project allowlist. It is the only gate that reads the trigger declarations the matcher will use.
2. `node packages/skills/test/governs-declaration.mjs`: the `governs:` key, admitted and refused. Run it whenever the file declares one.
3. The reader's own count, not a character count by eye:

```bash
node -e 'import("./packages/core/src/extensions/core/skills-tool/skill-triggers.ts").then(t=>{const p=process.argv[1];const e=t.readSkillTriggerEntries(p);console.log(e.length, Math.max(...e.map(x=>x.phrase.length)), e)})' packages/core/skills/<name>/SKILL.md
```

4. **Tamper test.** Break one field on purpose, run the gate, read the failure by name, restore the file. A green run you have never watched fail is a claim about the gate, not about the file.

The contract is shared code, so its frontmatter half applies to any skill tree, including the core set. Its allowlist half is scoped to the pack that owns the table; a core skill legitimately names tools the pack cannot reach.

## Step 6: prove it fires, and prove it does not over-fire

Pick at least three prompts the skill must serve and at least two near-misses that share its vocabulary and must not fire; a should-not-fire prompt that is obviously unrelated tests nothing. Write the prompts down before you tune the phrases: a probe set assembled after you know what the phrases match measures nothing. Run them through the shipped matcher rather than reasoning about them:

```bash
node -e 'import("./packages/core/src/extensions/core/skills-tool/applicability.ts").then(a=>console.log(a.skillApplicability({name:"<name>",triggers:["<phrase>"]}, process.argv[1])))' "<prompt text>"
```

Then measure it in production, where the interesting number is not the suggestion count but the conversion. The adoption counters give three buckets: a skill the whisper suggests and nobody opens is `needs-refresh` and the fix is usually the description, not the body; a skill with no suggestion and no load in the window is a `prune` candidate; a skill with loads is `active`. A shipped skill with no read evidence is `UNVALIDATED`, never `KEEP`, and one session with zero loads is not a trend.

## Retire or merge

Retiring a skill takes three things, not one: `status: deprecated`, a `successor:` naming what to do instead in terms a user can act on, and a description that opens with "Deprecated:" so the file cannot be read as a live instruction. A deprecated file without a successor is a tombstone standing where the instruction used to be. The deprecation convention the instrument reads (date and reason) is meta-improvement's; the three fields above are the contract's, and the contract is what fails a release.

Merging is usually the better move. The core set's code-search is the shipped fold: `status: merged`, `successor: code-refactoring`, and a banner at the top of the body. The contract defines only the deprecated branch, so a merged file keeps its own catalog row and its own read cost; if it declares no phrase it never fires, which is the right end state for a pointer that exists so a search for the old name lands somewhere.

## Match the form to the failure

The form of the guidance is a decision, not a style preference. The same wording that fixes one failure type measurably worsens another.

| Baseline failure                                            | Right form                                              | Wrong form                            |
| ----------------------------------------------------------- | ------------------------------------------------------- | ------------------------------------- |
| Skips a known rule under pressure                           | prohibition, rationalization table, red-flag list       | soft guidance ("prefer", "consider")  |
| Complies but the output has the wrong shape                 | a recipe stating what the output is, its parts in order | a prohibition list                    |
| Omits a required element from something it already produces | a required field in the template it fills               | a reminder in prose near the template |
| Behavior should depend on a condition                       | a conditional on an observable predicate                | an unconditional rule plus exemptions |

Two corollaries hold across all four: a nuance clause ("don't X unless it matters") reopens the negotiation the rule was meant to close, and an exemption clause does not scope: "this limit does not apply to code blocks" still suppresses code blocks.

## Symptom to fix

| Symptom                            | Mechanism, and the fix                                                                                  |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Never suggested                    | fewer than two phrases, or phrases nobody types; add phrases from the failing baseline's vocabulary     |
| Fires on unrelated prompts         | a phrase names the subject rather than the situation; subject words are in every prompt                 |
| Read, then ignored                 | the description summarized the workflow, so the agent followed the summary; strip it to conditions      |
| Body advice ignored under pressure | a discipline failure answered with soft guidance; switch to prohibition plus rationalizations           |
| Same helper rewritten every run    | the skill is missing its instrument; move it into `scripts/` of the owning package and name the command |
| Validator refuses a field          | the contract's reader is line-based and literal; match its shape rather than arguing with it            |

## What this skill does not cover

It does not supply the domain knowledge the skill teaches, and it does not run the experiment loop that compares two versions of a body; that measurement belongs to meta-improvement, and the adoption counters belong to skill-usage. This file only makes the carrier correct.
