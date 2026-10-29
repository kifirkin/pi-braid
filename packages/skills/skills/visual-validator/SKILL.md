---
name: visual-validator
description: "Use when a finished visual has to be judged rather than made: a screenshot, a sprite sheet, a slide. Produces a DESIGN AUDIT with measured dimensions, dominant colors with percentages, contrast ratios, spacing variance and alignment offsets, then P0/P1/P2 findings with a measurable delta for each. Not for creating the asset (visual-creator) and not for writing the token contract (design-system)."
triggers:
  - "visual validation"
  - "design critique"
  - "sprite analysis"
  - "UI audit"
  - "image quality check"
  - "review this screenshot"
  - "design defects"
validated: 2026-10-27
verdict: IMPROVE
governs:
  - document
---

# Visual Validator

Professional design critique with evidence-based, actionable fixes.

---

## What this skill is for

This skill is the VALIDATE step: it judges a visual that already exists. Pair it with:

- **visual-creator** - chooses the palette, scale, and composition (the CREATE step)
- **design-system** - writes and enforces the token contract
- [`_shared/inspect-image.md`](../_shared/inspect-image.md) - how to get the pixels in front of you

If you are choosing values rather than judging them, you are in the wrong file.

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
```

---

## Method: how each number is obtained

A measurement you cannot source is a guess with a decimal point. Use the first
row that applies, and say which instrument you used.

| Metric                | Instrument                                                                      | If the instrument is missing                                       |
| --------------------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| The image itself      | Read the file: an image path passed to the `read` tool arrives as an attachment | Ask the user for the file or a larger crop                         |
| A PDF page            | `document_screenshot` renders it to PNG; read that                              | Ask for a screenshot                                               |
| Dimensions            | The file's pixel size, or the size the attachment reports                       | Do not estimate; say unknown                                       |
| Dominant colors and % | Count over the image's pixels; report the top five with their area share        | Report colors qualitatively and say the percentages are unmeasured |
| Contrast ratio        | WCAG relative luminance from the two values: (L1+0.05)/(L2+0.05)                | Compute it by hand; this is arithmetic, not perception             |
| Spacing variance      | The distinct gap values you measured, and how many fall off the scale           | Say which gaps you could not measure                               |
| Alignment offset      | The x/y of element edges against the container axis                             | Report only what is visibly off-axis                               |

Two rules that outrank the table:

1. **Never state a hex, a ratio, or a percentage you did not measure.** "Deep
   blue, roughly a third of the canvas" is honest; an invented "#1A2B3C, 31%"
   is the failure this skill exists to prevent.
2. **Say which metric drove the severity.** A P0 blocks use (unreadable text, a
   control you cannot see); a P1 costs comprehension; a P2 is polish. Twenty P2s
   and no P0 is a good screen.

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

1. **CAPTURE** - read the image as an attachment (see `_shared/inspect-image.md`)
2. **MEASURE** - Extract dimensions, colors, positions
3. **COMPARE** - Measure the reference the same way and compare the numbers, not the impressions
4. **AUDIT** - Apply design criteria
5. **TRIAGE** - P0/P1/P2 classification
6. **PRESCRIBE** - Specific actionable fixes

---

## Anti-patterns

These undermine credibility:

- "Looks better" without measurement
- Vague advice without specific values
- A hex, a ratio, or a percentage you did not measure
- Ignoring evidence of critical failure
- Accepting "close enough" when delta exceeds tolerance
