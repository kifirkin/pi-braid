---
name: visual-validator
description: "Use when a finished visual has to be judged rather than made: a screenshot of a page at phone width that looks bad and nobody can say why, a sprite or icon that turns into a blob at small size, a slide nobody can read from the back of the room, or text that fails against its background. Owns the design loop - measure with design_audit, decide the identity in writing, build, re-measure, compare - and reports P0/P1/P2 findings with a measurable delta. Not for choosing the palette (visual-creator), not for authoring the token contract (design-system), and not for building a landing page's mechanics (landing-page)."
triggers:
  - "visual validation"
  - "design critique"
  - "sprite analysis"
  - "UI audit"
  - "image quality check"
  - "review this screenshot"
  - "why it looks bad"
  - "design defects"
validated: 2026-10-27
verdict: IMPROVE
governs:
  - document
  - design
---

# Visual Validator

Professional design critique with evidence-based, actionable fixes.

---

## What this skill is for

This skill owns judgement, and the loop that makes judgement reproducible: it
measures a visual that already exists, then carries that measurement through
decide, build, re-measure and compare. The rest of the work sits around it:

- **visual-creator** - chooses the palette, scale, and composition (the decide step)
- **design-system** - writes and enforces the token contract
- **landing-page** - the page-building mechanics between them
- [`_shared/inspect-image.md`](../_shared/inspect-image.md) - how to get the pixels in front of you

If you are choosing values rather than judging them, this is not where the
choice is made; it is where the choice is measured.

---

## The loop (owned here)

Every design job runs one loop. This file owns it; `visual-creator`,
`design-system` and `landing-page` point here instead of restating it.

1. **Measure, before anything changes.** Run `design_audit` on the untouched
   artifact:

   ```
   design_audit(target: "<url-or-file>", widths: [320, 390, 768, 1440])
   ```

   Those four widths are the default, and they are the phone, the large phone,
   the tablet and the desktop. Pass `design_md:` when the project keeps its
   token file where the tool will not find it beside the target; pass
   `screenshot_dir:` when the PNGs should land somewhere other than the braid
   home. One full-page PNG per width is written, and reading them is part of
   the measurement: the numbers cannot see cheapness.

2. **Decide, in writing.** Name the identity decisions the artifact will carry:
   the type step (which sizes and weights, at what ratio), the colour role table
   (dominant surface, action colour, accent, and where each is allowed), and the
   spacing rhythm (the step and the section cadence). A decision that lives only
   in the session is not a decision: the next session invents a different one.

3. **Build the smallest set of changes that serves those decisions.** Not the
   set that raises a count. Identity comes from a few committed choices repeated
   consistently, not from many small fixes.

4. **Re-measure with the same instrument at the same widths.** A different
   tool, width, or target is a different measurement, not a comparison.

5. **Compare, in a table pasted into the report.** One row per metric, before
   and after, at each width where it moved:

   | metric (`design_audit` field)                                     | before | after |
   | ----------------------------------------------------------------- | ------ | ----- |
   | `findings.total` per width                                        |        |       |
   | `contrast.failures[]` count; the failing `path` selectors named   |        |       |
   | `overflow[]` count at 320                                         |        |       |
   | `tapTargets[]` count                                              |        |       |
   | distinct `inventory.fontSizes` / `spacings` / `radii`             |        |       |
   | `colors[].coverage` for the dominant, secondary and accent values |        |       |
   | `inventory.*` values with `inTokens: false`                       |        |       |

### What the loop will not let you claim

- **A design claim without a pasted before/after table does not count.** Same
  rule as any other measurement: re-derive it with your own instrument. "It
  looks better now" is an impression; the table is the claim.
- **Zero findings is not the end.** Zero means nothing is broken. The work is
  finished when the identity decisions from step 2 are visible in the artifact
  and the numbers moved the way those decisions predicted, or when a named
  decision was deliberately reverted and the reason is written beside it.
- **The three-decision check.** Open the render and name three decisions you
  can see in it: the type step, the colour roles in use, the spacing rhythm, a
  repeated component shape. If you cannot name three, the artifact has no
  identity. A clean audit on such a page says only that it is not broken.

### The ruler, named

`design_audit` returns `widths[]`, one entry per measured width, and an
audit-level `findings` that is the narrowest width's. The fields this file
judges by:

| Field                                   | What it answers                                                                                                                |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `contrast.checked` / `contrast.skipped` | How many text-bearing elements were measured, and how many could not be                                                        |
| `contrast.failures[]`                   | Every failing pair with `path` (selector), `text`, `foreground`, `background`, `ratio`, `required`, `fontSizePx`, `fontWeight` |
| `overflow[]`                            | Every element crossing the viewport, with `path`, `reason` (`scroll` or `viewport`), `right`, `scrollWidth`, `clientWidth`     |
| `tapTargets[]`                          | Every control under 44×44, with `path`, `width`, `height`                                                                      |
| `findings`                              | `contrast`, `offGrid`, `missingTokens`, `tapTargets`, `overflow`, `total`                                                      |
| `documentHeight`                        | The page's own height at that width                                                                                            |

Read `findings` at every width, not only the audit-level one: a page clean at
320 can still overflow at 768.

---

## Universal Measurements

Always extract for any visual asset:

| Metric              | Value                        |
| ------------------- | ---------------------------- |
| Dimensions          | {width}×{height}px           |
| Aspect Ratio        | {ratio}:1                    |
| Dominant Colors     | Top 5 hex codes with %       |
| Information Density | high/medium/low              |
| Layout Quadrants    | Element summary per quadrant |

---

## The Audit Format

```markdown
## DESIGN AUDIT: [filename]

### 1. OVERALL ASSESSMENT

[One sentence professional verdict]

### 2. GESTALT ANALYSIS

| Principle              | Status   | Evidence            |
| ---------------------- | -------- | ------------------- |
| Silhouette Readability | ✅/⚠️/❌ | [Measured evidence] |
| Figure-Ground          | ✅/⚠️/❌ | [Measured evidence] |
| Form Continuity        | ✅/⚠️/❌ | [Measured evidence] |
| Visual Weight Balance  | ✅/⚠️/❌ | [Measured evidence] |
| Proportion             | ✅/⚠️/❌ | [Measured evidence] |

### 3. ISSUE TRIAGE

#### P0 - CRITICAL (Breaks the asset)

- **Issue**: [Clear description]
- **Evidence**: [Pixel measurements, specific values]
- **Fix**: [Specific actionable fix]

#### P1 - MAJOR (Significant quality gap)

- **Issue**: [Description]
- **Evidence**: [Measurements]
- **Fix**: [Values to change]

#### P2 - MINOR (Polish)

- **Issue**: [Description]
- **Fix**: [Minor adjustments]

### 4. ACTIONABLE FIX LIST

1. `[P0]` [Specific code change with values]
2. `[P1]` [Specific code change with values]
3. `[P2]` [Specific code change with values]

### 5. BEFORE / AFTER

[The comparison table from The loop, pasted. A report without it has measured
nothing.]

### 6. IDENTITY

[Three decisions visible in the render, named. "None visible" is itself a
finding: a clean page with no identity fails this check at zero P0/P1/P2.]
```

---

## Method: how each number is obtained

A measurement you cannot source is a guess with a decimal point. Use the first
row that applies, and say which instrument you used.

| Metric                | Instrument                                                                                                                                                | If the instrument is missing                                        |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| The image itself      | Read the file: an image path passed to the `read` tool arrives as an attachment                                                                           | Ask the user for the file or a larger crop                          |
| A PDF page            | `document_screenshot` renders it to PNG; read that                                                                                                        | Ask for a screenshot                                                |
| A rendered page       | `design_audit` at 320, 390, 768 and 1440: contrast per text pair with selectors, colour coverage, values in use, tap targets, overflow, one PNG per width | Say which width could not be rendered; do not substitute an eyeball |
| Dimensions            | The file's pixel size, or the size the attachment reports                                                                                                 | Do not estimate; say unknown                                        |
| Dominant colors and % | For a rendered page read `colors[].coverage` from `design_audit`; otherwise count over the image's pixels. Report the top five with their area share      | Report colors qualitatively and say the percentages are unmeasured  |
| Contrast ratio        | WCAG relative luminance from the two values: (L1+0.05)/(L2+0.05)                                                                                          | Compute it by hand; this is arithmetic, not perception              |
| Spacing variance      | The distinct gap values you measured, and how many fall off the scale                                                                                     | Say which gaps you could not measure                                |
| Alignment offset      | The x/y of element edges against the container axis                                                                                                       | Report only what is visibly off-axis                                |

Two rules that outrank the table:

1. **Never state a hex, a ratio, or a percentage you did not measure.** "Deep
   blue, roughly a third of the canvas" is honest; an invented "#1A2B3C, 31%"
   is the failure this skill exists to prevent.
2. **Say which metric drove the severity.** A P0 blocks use (unreadable text, a
   control you cannot see); a P1 costs comprehension; a P2 is polish. Twenty P2s
   and no P0 is a good screen by defect standard. It still has to pass the
   three-decision check (see The loop).

---

## Sprite Critique Criteria

| Aspect               | Check                             | Pass                       |
| -------------------- | --------------------------------- | -------------------------- |
| **Silhouette**       | Distinct profile at small scale   | Readable at 16×16px        |
| **Proportion**       | Head-to-body ratio                | ±5% of target              |
| **Perspective**      | Consistent view angle             | 3/4 side or true side      |
| **Form Continuity**  | No floating/detached parts        | Arms at shoulders          |
| **Detail Placement** | Key features in correct positions | Eye forward, quills behind |

---

## Animation State Critique

| State               | Check                         | Target                                                          |
| ------------------- | ----------------------------- | --------------------------------------------------------------- |
| **Keyframes**       | Minimum viable frames         | idle: 2, walk: 4, run: 6, attack: 4 (owned by `visual-creator`) |
| **Weight Shift**    | Body leans into movement      | run: 15-25° forward lean                                        |
| **Cycle Integrity** | First and last frame match    | Same pose, same position                                        |
| **Limb Sync**       | Arms and legs opposite phases | Left arm forward = Right leg forward                            |

---

## Integration

The loop above is the integration; these are its anchors.

1. **CAPTURE** - read the image as an attachment (see `_shared/inspect-image.md`), or point `design_audit` at the rendered page
2. **MEASURE** - `design_audit` at 320, 390, 768 and 1440; keep both the numbers and the PNGs
3. **DECIDE** - the identity decisions, in writing
4. **BUILD / RE-MEASURE / COMPARE** - same instrument, same widths, table pasted
5. **TRIAGE** - P0/P1/P2 inside the comparison, not instead of it
6. **PRESCRIBE** - specific values, taken from the table

Choosing the values is `visual-creator`; writing the token contract is
`design-system`; the landing-page mechanics are `landing-page`.

---

## Anti-patterns

These undermine credibility:

- "Looks better" without measurement
- Vague advice without specific values
- A hex, a ratio, or a percentage you did not measure
- A before/after claimed without the pasted table
- A clean audit presented as a finished design
- P0=0 used as the stopping rule
- Ignoring evidence of critical failure
- Accepting "close enough" when delta exceeds tolerance
