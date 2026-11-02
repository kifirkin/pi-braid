---
name: cv-improvement
description: "Use when a CV or resume has to be measured and improved rather than rewritten from taste: every bullet opens the same way, the skills list carries words the experience never mentions, the page budget is about to break, or the draft reads as machine-written. Supplies the metric formulas, the failure catalogue keyed to the form, the fix order, and the honesty rules that keep unconfirmed numbers out. Not for cover letters, profile translation, or interview preparation."
validated: 2026-11-02
verdict: UNVALIDATED
triggers:
  - "improve my cv"
  - "improve my resume"
  - "fix my cv"
  - "fix my resume"
  - "rewrite my resume"
  - "cv review"
  - "resume review"
  - "resume bullets"
  - "cv reads as generated"
  - "resume sounds like ai"
  - "ai-generated resume"
  - "resume is three pages"
  - "skills list is padded"
  - "my own cv"
  - "polish my cv"
---

# CV Improvement

A CV is scanned before it is read, and the scan decides whether the read happens. A machine-written CV gives itself away in form before vocabulary: every bullet built to one template, a colon and a list where a result belongs, skills the experience text never mentions. Measure the form, name the mechanism, fix one mechanism at a time.

Everything below works on any CV in any language. Where the language decides the answer (what a past-tense verb looks like, which punctuation is orthography), the formula says so. Where the answer is a fact only the owner holds, the metric says that too.

## Step 1: measure before reading for style

Run the metric set first. The baseline is what makes the edit checkable: a fix measured against memory is a guess, and a fix measured against a different document is a coincidence. Count the unit the document uses. A profile field on a job board has paragraphs where a CV has bullets, and the formulas read the same either way.

### The metric set

Marks: **D** is derivable from the document by the formula. **O** needs the owner's answer. A count is usually derivable; the bar it is compared to is sometimes the owner's ruling, and a row can carry both.

| #   | Metric                         | Formula: what is counted, per what unit                                                                                                                                                                                                                                          | Failing value, and what evidences it                                                                                                                                                                                                                                                                                                                              | Mark                                 |
| --- | ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| 1   | Bullets                        | Bullets under all employers.                                                                                                                                                                                                                                                     | Not a defect on its own: 24 to 23 changed nothing that the other rows did not already name. It is the denominator for rows 2 to 8.                                                                                                                                                                                                                                | D                                    |
| 2   | Bullet length, mean and spread | Mean words per bullet, its standard deviation, and the minimum and maximum.                                                                                                                                                                                                      | An even row, where every bullet sits within a few words of the mean. The measured pair is 18.5 (sd 7.6, 5 to 33 words) and 19.0 (sd 7.3, 8 to 33): the accepted revision did not widen the spread either. Read this row as a veto, not as proof: a row with no spread is a defect, and a fix cannot be scored on a metric its own accepted revision did not move. | D                                    |
| 3   | Distinct first words           | Distinct case-folded first tokens of the bullets, over n, plus each repeated token with its count.                                                                                                                                                                               | Any repeated opener. The measured pair is 18 of 24 with four repeated verbs, then 23 of 23.                                                                                                                                                                                                                                                                       | D                                    |
| 4   | Verb-first share               | Bullets whose first token is a capitalised word ending in -ed (English) or in л, ла, ли (Russian), over n.                                                                                                                                                                       | The measured pair is 16 of 24, 67%, then 9 of 23, 39%. The test also catches nouns that end that way, so read the hits instead of trusting the count.                                                                                                                                                                                                             | D                                    |
| 5   | Colon-list share               | Bullets with a colon where the bullet opens with a past-tense verb and the text after the colon holds at least three comma-separated items, over n.                                                                                                                              | The measured pair is 9 of 24, then 3 of 21. The source's own denominator for this row is 21 against 23 bullets: count your denominator rather than inheriting one.                                                                                                                                                                                                | D                                    |
| 6   | Longest enumeration            | The highest comma count in any one bullet.                                                                                                                                                                                                                                       | Seven or more. The measured pair is 9, then 6.                                                                                                                                                                                                                                                                                                                    | D                                    |
| 7   | Unbacked skills                | Declared skill items minus the items whose head token occurs in the experience text, case-folded; list the misses.                                                                                                                                                               | The measured pair is 11 of 27, then 8 of 24, and two of the eight survivors are confirmed by paraphrase rather than by the exact word. Any survivor needs a reason the owner can say aloud.                                                                                                                                                                       | D for the list, O for the ruling     |
| 8   | Repeated sequences             | Distinct 3-token and 4-token sequences occurring two or more times, with occurrence counts.                                                                                                                                                                                      | Any 4-token repeat that is not the summary naming the detail printed below it. The measured pair is 2, then 1, and the one kept is deliberate.                                                                                                                                                                                                                    | D                                    |
| 9   | Type-token ratio               | Unique case-folded alphabetic word forms over the total, across bullets and paragraphs.                                                                                                                                                                                          | No absolute bar. Read it only before and after on one document: shortening a text lowers it mechanically, and the measured move from 0.67 to 0.68 happened on a text 3% shorter, which reads as repeated material leaving rather than new vocabulary arriving.                                                                                                    | D                                    |
| 10  | Non-ASCII punctuation          | Characters outside ASCII plus the letters and quotation marks of the document's language, counted per document, with each offending character listed.                                                                                                                            | Any, when the owner writes without them. The measured pair is 13, then 0. The same measurement over other people's CVs put 6 to 8 pause dashes per document, so the count is not the defect; the mismatch with the person who reads it is.                                                                                                                        | D for the count, O for the bar       |
| 11  | Capital in a date range        | For every date range, whether the first letter after the separator is uppercase.                                                                                                                                                                                                 | Any. The measured pair is 6, then 0. Russian lowercases the second month; English capitalises both, and the row does not apply there.                                                                                                                                                                                                                             | D                                    |
| 12  | Page count and last-page fill  | Pages in the rendered file. Fill is the bottom coordinate of the lowest text box on the last page divided by the page height.                                                                                                                                                    | More pages than the budget. Fill under 55% reads unbalanced; over 97% is one edit away from a new page. The measured values are 2 pages at 96% and 83%, where 9.5 pt held two pages and 10.2 pt produced a third.                                                                                                                                                 | D from the rendered file             |
| 13  | Evaluative modifiers           | Hits from a closed list per 100 words: полностью, практически, успешно, современный, эффективный, значительный, уникальный, сильный, основной; completely, practically, successfully, modern, effective, significant, unique, strong, key.                                       | The count locates sentences; it does not settle them. Read each hit and ask which noun the modifier describes, and whether that claim can be checked.                                                                                                                                                                                                             | D for the count, a read per hit      |
| 14  | Lead-in lines                  | Lines between the employer line and the first bullet of that block.                                                                                                                                                                                                              | More than three. The measured pair is four lines of org structure, then two.                                                                                                                                                                                                                                                                                      | D                                    |
| 15  | Agentless passive              | Finite passive constructions per block: an auxiliary or a short participle with no named agent. The Russian shapes are были, был, была, было plus a participle, and the short forms ending in -ны, -на, -но, -то. The English shape is was, were or been plus a past participle. | Any, where the sentence reports an achievement: the achievement turns into a state of the world and the person disappears from their own bullet. The source lists them as a defect class and removes them by naming the actor.                                                                                                                                    | D for the candidates, a read per hit |
| 16  | Header role count              | Segments of the title line and the specialisation line, split on a slash, a middle dot or a pipe.                                                                                                                                                                                | More than one role segment, or a stack of near-synonyms. The measured case had four role names in a row; the line left the document and the words moved to the platform's search field.                                                                                                                                                                           | D                                    |

### What the document cannot answer

Four things, asked before the first edit:

1. **What the document is for.** The target role and the page budget decide what to cut. A CV with no target keeps everything and ranks nothing.
2. **Whose typography it is.** Which dashes, quotation marks and letter forms the person who reads it writes. The count is measurable; the ruling is theirs.
3. **Numbers that are not in the text.** Effect, scale, headcount, thresholds. No formula recovers them, and a plausible number is a lie with a decimal point. Leave the slot and ask.
4. **Whether a skill word is true.** The text cannot prove it. The owner either confirms it and can defend it in the first interview minute, or it comes out.

## Step 2: name the mechanism in one sentence

Before the first edit, write the cause down in a sentence someone could falsify: "every bullet opens with a past-tense verb because the draft was rewritten from a job description, one line per duty." A mechanism names a cause; a taste note names a preference. The mechanism decides which fix is allowed and which metric proves the fix landed. A fix with no named mechanism is a rewrite with a nicer reason.

## The failure catalogue

Keyed to the form, not to taste. Each row states what the reader sees, the mechanism that produces it, the fix that addresses the mechanism, and the metric that proves the fix.

| Symptom                                                                                   | Mechanism                                                                                                                     | Fix                                                                                                                                                            | Proving      |
| ----------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ |
| Ten bullets deep, bullet twelve is indistinguishable from bullet three.                   | One generative template applied to every bullet, whatever speech act the bullet performs.                                     | Name the speech act per bullet. Keep the verb where there is a result; open with a noun where the bullet reports what the product is or was.                   | 3, 4         |
| Everything is "did X: a, b, c".                                                           | The enumeration is easier to produce than the result, so it stands where the result belongs.                                  | Enumerate only where the list is checkable (modules, on-call groups, thresholds, grades), cap it at four, and spend the other bullets on outcomes.             | 5, 6         |
| The summary repeats its own bullets.                                                      | The summary was written by copying the bullets rather than compressing them.                                                  | The summary states the role, the scale and the direction; each detail appears once, below.                                                                     | 8            |
| Modern, practically all, fully, successfully.                                             | An adjective about the author's judgement of their own work carries no checkable claim, so the reader discounts the sentence. | Replace the modifier with the fact it stands for: a version migration is a migration, not a modernisation.                                                     | 13           |
| The skills list carries technologies from a decade ago and words the text never mentions. | The list was copied from an old export and never reconciled with the experience text.                                         | Group the list. Keep a word only if the text supports it, or the owner confirms it and can defend it aloud.                                                    | 7            |
| Old blocks read as noun fragments, new blocks as verbs, and the seam is visible.          | A partial rewrite: the new sections were rebuilt, the old ones patched.                                                       | Rewrite the old blocks to say what the person did, not what the product consisted of.                                                                          | 4, per block |
| Were replaced, was delivered.                                                             | The subject disappears and the achievement becomes a state of the world.                                                      | Name the actor and the object.                                                                                                                                 | 15           |
| Four lines of org structure before the first fact.                                        | The export's hierarchy fields were copied whole; the scan meets structure where it expects a fact.                            | Employer, title line, department. The rest of the hierarchy goes.                                                                                              | 14           |
| A sentence the owner cannot defend if asked.                                              | The document asserts more than the record supports, and the first interview question finds it.                                | State the unfinished or unmeasured state plainly. An unfinished migration named as unfinished costs less than a finished one that unravels under one question. | see Honesty  |
| The header is a stack of role names.                                                      | The search field was pasted into the document, so positioning became keywords.                                                | One role line. Specialisations and keywords belong to the platform field, not the page.                                                                        | 16           |

## Step 3: fix one mechanism at a time

Order of work, and the reason for it:

1. **Form.** Rows 3, 4, 5, 6, 15 and 16 first, because they change which sentences exist. Editing wording before fixing the template means rewriting the same bullets twice.
2. **Evidence.** Row 7, then the unbacked claims. The document's claims set the ceiling on everything else; a well-shaped bullet built on an unconfirmed number is the worst of both.
3. **Surface.** Rows 14 and 13: the lead-in lines and the modifiers. They are cheap, and they stop the reader's scan before it reaches the substance.
4. **Typography.** Rows 10 and 11 last among the text edits, because every earlier fix rewrites text and reopens the punctuation.
5. **Compression.** Row 12 last, because it is the constraint every previous fix spends: a fix that adds a third page is not a fix, and the font size is not the lever for it.

After each fix, re-run the metrics that fix names and record the pair in the same table. If the metric the fix names did not move, the fix addressed something else, and the pair says so.

One mechanism per pass. A combined edit cannot be attributed, and the next reviewer cannot tell which change helped.

## Step 4: gates before publishing

- **Every number is traceable** to an owner answer or a named artifact. A number with no source is deleted, not softened.
- **Every skill word appears** in the experience text, or the owner has confirmed it and will survive the first question about it.
- **Every bullet has an object**: a person, a system, a number or a decision.
- **The page count is rendered**, not estimated. The budget is the owner's; the count is the file's.
- **Read it aloud.** A sentence that needs a footnote to be read aloud is a sentence to cut.

## Honesty

1. **No invented metrics.** A number enters the document from the owner's answer or a named artifact. A CV with scale numbers is not weaker than one with invented effect numbers; it is weaker by exactly one interview question fewer.
2. **No causality the source does not support.** A rank earned in the same year as your releases was not caused by them unless the source says so. Write the place, not the cause.
3. **No adjective without an object.** Every modifier must describe a noun that can be checked. "Significant" describes nothing until it has a before and an after.
4. **No false-modesty register either.** "Just", "only", "basically", and the shape that credits the author for a team's shared work are the same defect as self-praise: an evaluation standing where a fact belongs. The fix is the same one, the fact.
5. **Every skill word appears in the experience text, or it is removed.** The skills list is a claim about the text, and the first interview tests the claim.
6. **The owner confirms every number.** Nothing is published that the owner has not seen and confirmed in the sentence where it appears.

## Worked example

Before:

> Improved the billing pipeline: caching, retries, batching, monitoring, alerts, dashboards.
>
> Significantly reduced the support load.

Both bullets fail on form: the first is a verb plus a six-item colon list (rows 5 and 6), the second has a modifier with no object (row 13) and no number. After, with the slots left for the owner:

> Cut the nightly billing run from [before] to [after] by batching the charge writes.
>
> Support tickets about failed invoices fell from [before] to [after] once the retry fix shipped.

The slots are the point. The shape is now a result with an object, and the two numbers are the only thing the writer cannot supply: they come from the owner, or the bullet keeps the slot and never ships with a guess in it.

## What this skill does not cover

Cover letters, profile translation, interview preparation, salary negotiation, and the design of one base CV cut into several targeted versions. It also cannot tell you whether a claim is true. It can tell you which claim is doing no work, and where the evidence would have to come from.
