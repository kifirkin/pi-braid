---
name: design-system
description: "Use when a project needs a written visual identity other sessions can follow, or when an existing DESIGN.md and the code have drifted apart. Produces the token file plus its rationale and enforces it with `npx @google/design.md lint` (published, format alpha): lint findings, a diff between versions, export to Tailwind or DTCG. Not for judging whether one screen looks good (visual-validator) and not for choosing a palette from scratch (visual-creator)."
validated: 2026-10-27
verdict: IMPROVE
triggers:
  - DESIGN.md
  - design tokens
  - brand identity
  - style guide
  - design system
  - token drift
  - palette drift
---

# Design System & Brand Identity

Build and maintain a durable visual brand identity using the DESIGN.md format. The format is a specification with a published linter and exporter: `@google/design.md`.

> **The CLI is published; the format is alpha.** `@google/design.md` is on npm
> (0.4.0 at the time of writing) and ships `lint`, `diff`, `export`, and
> `spec`. Run it with `npx`; pin the major version in CI. The format itself is
> marked `alpha` upstream, so when lint disagrees with this skill, lint is
> right and this skill is stale: re-read the format specification in the
> repository below, which is what lint implements.

---

## The DESIGN.md Format

A DESIGN.md file combines machine-readable design tokens (YAML front matter) with human-readable design rationale (markdown). Tokens give agents exact values. Prose tells them _why_ those values exist and how to apply them.

```
---
version: alpha
name: My Brand
colors:
  primary: "#1A1C1E"
  secondary: "#6C7278"
typography:
  h1:
    fontFamily: Public Sans
    fontSize: 48px
    fontWeight: 600
rounded:
  sm: 4px
  md: 8px
spacing:
  sm: 8px
  md: 16px
---

## Overview

The brand evokes architectural minimalism meets journalistic gravitas.
```

Consistency depends on two things, and neither is automatic: an agent reading this file, and `lint` running in the loop. A token file nobody reads and nothing checks is a wish.

---

## 1. Token Schema Reference

```yaml
version: <string> # optional, current: "alpha"
name: <string>
description: <string> # optional
omitted: <string[] | OmittedSection[]> # optional, sections you intend to leave out
```

The rest of this section is the token types those fields hold. Tokens may live
in the file's front matter or be interleaved as fenced `yaml` blocks inside the
`##` sections they document; both are valid.

### 1.1 Colors

```yaml
colors:
  <token-name>: <css-color>
```

The spec accepts any CSS color: hex (`#1A1C1E`), `rgb()`, `oklch()`, or a named color. Do not reject a token because it is not a hex value.

| Token name convention | Example   | Role                                   |
| --------------------- | --------- | -------------------------------------- |
| `primary`             | `#855300` | Brand color, primary actions           |
| `on-primary`          | `#FFFFFF` | Text/icon color ON primary backgrounds |
| `primary-container`   | `#FFDDB8` | Surface variant of primary             |
| `secondary`           | `#0058BE` | Secondary actions, accents             |
| `surface`             | `#F9F9FF` | Main background                        |
| `surface-container`   | `#E7EEFE` | Card/container background              |
| `outline`             | `#867461` | Borders, dividers                      |
| `error`               | `#BA1A1A` | Destructive actions                    |
| `background`          | `#F9F9FF` | Page/app background                    |
| `on-background`       | `#151C27` | Text on background                     |

**Material Design 3 convention**: use the full M3 palette surface system for elevation depth:
`surface`, `surface-dim`, `surface-bright`, `surface-container-lowest`, `surface-container-low`, `surface-container`, `surface-container-high`, `surface-container-highest`, `surface-tint`

### 1.2 Typography

```yaml
typography:
  <token-name>:
    fontFamily: <string> # Font name or font stack
    fontSize: <dimension> # e.g., 48px, 1.5rem
    fontWeight: <number> # 300, 400, 500, 600, 700, 800
    lineHeight: <dimension|number> # e.g., 52px or 1.3 (unitless = multiplier of fontSize)
    letterSpacing: <dimension> # e.g., -0.02em, 0.5px
    fontFeature: <string> # optional: font-feature-settings value
    fontVariation: <string> # optional: font-variation-settings value
```

| Token name convention                | Scale role                  |
| ------------------------------------ | --------------------------- |
| `display`                            | Hero text, 2.5-3.5rem       |
| `headline-lg` / `headline-md`        | Page/section titles         |
| `title-lg` / `title-md` / `title-sm` | Card titles, nav items      |
| `body-lg` / `body-md` / `body-sm`    | Reading text                |
| `label-lg` / `label-md` / `label-sm` | Buttons, captions, metadata |

**Font size scale (recommended)**: 12, 14, 16, 18, 20, 24, 32, 44, 56px

### 1.3 Spacing & Rounded

```yaml
spacing:
  xs: 4px # Micro spacing: icon margins
  sm: 8px # Dense spacing: input padding
  md: 16px # Default spacing: card padding
  lg: 24px # Section spacing: between sections
  xl: 40px # Large spacing: page margins
  xxl: 64px # Macro spacing: hero padding
  gutter: 16px # Grid gutters
  margin: 24px # Page margins

rounded:
  sm: 4px # Subtle rounding: inputs
  md: 8px # Default: cards
  lg: 12px # Generous: buttons
  xl: 16px # Large: modals, sheets
  full: 9999px # Pill shape: badges, chips
```

**Naming convention**: use semantic level names (`sm`, `md`, `lg`, `xl`) not numeric values so you can change the value globally without renaming.

### 1.4 Components

```yaml
components:
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.on-primary}"
    typography: "{typography.label-md}"
    rounded: "{rounded.lg}"
    padding: "{spacing.md}"
  button-primary-hover:
    backgroundColor: "{colors.primary-container}"
    textColor: "{colors.on-primary-container}"
```

| Property                                                                           | Allowed values                              |
| ---------------------------------------------------------------------------------- | ------------------------------------------- |
| `backgroundColor` <!-- doc-ref-exempt: style property named in the token table --> | Color hex or `{colors.xxx}` token reference |
| `textColor` <!-- doc-ref-exempt: style property named in the token table -->       | Color hex or `{colors.xxx}` token reference |
| `typography`                                                                       | `{typography.xxx}` token reference          |
| `rounded`                                                                          | Dimension or `{rounded.xxx}` reference      |
| `padding`                                                                          | Dimension or `{spacing.xxx}` reference      |
| `size`, `height`, `width`                                                          | Dimension                                   |

**Variants**: use suffixes like `-hover`, `-active`, `-pressed`, `-disabled`, `-selected`

---

## 2. Building a Brand Identity

### 2.1 The Identity Brief

Before writing tokens, answer these questions to guide the prose sections:

1. **Brand personality**: serious vs playful, traditional vs innovative, premium vs accessible, loud vs quiet
2. **Target audience**: who uses this? What do they value?
3. **Emotional response**: how should users feel? (trusted, energized, calm, inspired)
4. **Competitive positioning**: how is this different from competitors visually?
5. **Context**: mobile app, web platform, game, physical materials, all of the above?

### 2.2 Creating the Design System

**Step 1 - Define the core palette:**

```yaml
colors:
  primary: "#855300" # Golden amber — warmth, action, trust
  secondary: "#0058BE" # Sky blue — calm, reliable, information
  tertiary: "#00658B" # Deep teal — premium, depth
  neutral: "#F9F9FF" # Warm off-white — approachable, not sterile
```

1. Pick one primary color that embodies the brand personality
2. Pick one secondary that complements it (split-complementary works well)
3. Pick an optional tertiary for rare accent moments
4. Derive neutrals that share the primary's undertone temperature

**Step 2 - Build typography:**

```yaml
typography:
  display:
    fontFamily: "Plus Jakarta Sans"
    fontSize: 44px; fontWeight: 800; lineHeight: 52px; letterSpacing: -0.02em
  headline-lg:
    fontFamily: "Plus Jakarta Sans"
    fontSize: 32px; fontWeight: 700; lineHeight: 40px; letterSpacing: -0.01em
  body-md:
    fontFamily: "Plus Jakarta Sans"
    fontSize: 16px; fontWeight: 400; lineHeight: 24px
  label-md:
    fontFamily: "Plus Jakarta Sans"
    fontSize: 14px; fontWeight: 600; lineHeight: 20px; letterSpacing: 0.01em
```

1. Choose primary typeface (the main workhorse)
2. If pairing, choose secondary for headings or accent
3. Build a modular type scale (start with 1.25× ratio)
4. Define weights: display/headline = bold (700+), body = regular (400), labels = semibold (600)

**Step 3 - Define spacing grid:**

Use the scale from §1.3 and nothing else. A DESIGN.md that carries two spacing
scales is the drift it exists to prevent.

```yaml
spacing:
  xs: 4px; sm: 8px; md: 16px; lg: 24px; xl: 40px; xxl: 64px
  gutter: 16px; margin: 24px
```

- Pick base unit (4px or 8px)
- Define scale: xs through xl
- Define layout-specific: gutter, margin, section

**Step 4 - Define component tokens:**

```yaml
components:
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.on-primary}"
    typography: "{typography.label-md}"
    rounded: "{rounded.lg}"
    padding: "{spacing.md}"
  button-primary-hover:
    backgroundColor: "{colors.primary-container}"
```

- Start with core components: buttons, cards, inputs, navigation
- Use token references (not hardcoded values) so changing one value propagates
- Define interaction variants for all interactive components

**Step 5 - Write prose sections:**
The markdown body explains rationale. Each section answers "why":

| Section           | What to include                                                           |
| ----------------- | ------------------------------------------------------------------------- |
| Overview          | Brand personality, target audience, emotional response, design philosophy |
| Colors            | Rationale for each palette choice, where/how to use each color            |
| Typography        | Font selection reasoning, scale logic, readability notes                  |
| Layout & Spacing  | Grid system, responsive behavior, spacing philosophy                      |
| Elevation & Depth | Shadow system, layering, interaction feedback                             |
| Shapes            | Corner radius logic, shape language meaning                               |
| Components        | Usage guidelines, interaction patterns, dos/don'ts                        |
| Do's and Don'ts   | Concrete examples of correct and incorrect usage                          |

Sections may be omitted, but the ones present must appear in the order above:
`section-order` is a lint rule, and an out-of-order file fails it.

---

## 3. Consistency Enforcement

### 3.1 The commands

```bash
# Lint: structural findings, broken token references, WCAG contrast per component
npx @google/design.md lint DESIGN.md
npx @google/design.md lint --format json DESIGN.md

# Diff two versions: added/removed/modified tokens plus a findings delta
npx @google/design.md diff DESIGN.md DESIGN-v2.md

# Export
npx @google/design.md export --format json-tailwind DESIGN.md > tailwind.theme.json
npx @google/design.md export --format css-tailwind  DESIGN.md > theme.css
npx @google/design.md export --format dtcg          DESIGN.md > tokens.json

# The rules lint applies, as data - own them when writing a custom check
npx @google/design.md spec --rules
```

`lint` exits non-zero when it finds errors and prints
`{"findings":[{severity,path,message}], "summary":{errors,warnings,infos}}`.
A contrast warning carries the measured ratio, so "does the palette pass WCAG?"
is answered by the tool rather than by the agent's eye. `export` exits 0 even
when the source has lint findings: run `lint` separately as the gate.

One caveat, stated rather than hidden: the subcommands and their exit codes
above are read from the package README, not re-run here. If `--help` on your
installed version disagrees, the installed version is right.

### 3.2 Cross-Screen Consistency Check

When verifying that a screen follows the DESIGN.md, run `lint` first and use its
findings as the input to these five checks:

1. **Color check**: scan every visible color. Does each one map to a token in the DESIGN.md? If not, it's a drift - either the design added an unauthorized color or the DESIGN.md is missing one.

2. **Typography check**: scan every text size. Does each map to a typography token? If text appears at sizes not in the type scale, it's drift.

3. **Spacing check**: measure gaps between elements. Do they match a value in the spacing scale? Gaps at non-scale values indicate drift.

4. **Component check**: do buttons match the button-primary/button-secondary tokens? Same colors, same rounding, same padding?

5. **Grid alignment**: do elements align to the defined grid? If not, realign.

### 3.3 Handling Drift

When consistency drift is detected:

| Drift type               | Action                                                                                        |
| ------------------------ | --------------------------------------------------------------------------------------------- |
| Unauthorized color in UI | Replace with nearest DESIGN.md color. If the new color is essential, add it as a new token.   |
| Non-scale spacing        | Snap to nearest spacing token. If the spacing is essential AND frequent, add it to the scale. |
| Wrong component token    | Replace with the correct token. Variants (hover/active) may need their own tokens.            |
| Missing component type   | Add new component tokens to DESIGN.md. Don't leave components tokenless.                      |
| Prose / token mismatch   | Update prose to match actual tokens, or update tokens to match prose. Tokens are normative.   |

### 3.4 Automated Checks

When writing code that consumes a DESIGN.md:

1. Extract all color values from the DESIGN.md into CSS custom properties or Tailwind config
2. Build a component library (React/Vue/Svelte) that references these tokens
3. Read the screenshot as an image attachment and cross-reference it against the DESIGN.md tokens (see §5); `visual-validator` owns the measurement vocabulary
4. For CI, pipe the token list into a custom lint script that validates CSS variables against the YAML - or use a static schema validator (`yaml-lint`, `ajv`) to catch structural errors in the DESIGN.md itself

---

## 4. Brand Evolution Workflow

### Adding a new color

```yaml
colors:
  # ...existing tokens...
  warning: "#F59E0B"
  on-warning: "#1A1C1E"
```

Then run `npx @google/design.md diff DESIGN.md DESIGN-v2.md` to verify that only the changes you intended appear.

### Deprecating a token

```yaml
colors:
  # Remove the token from the list
  # Document deprecation in prose:
  # ## Migration Notes
  # `primary-dark` has been removed. Use `primary-container` for dark backgrounds instead.
```

### Rebranding (full system change)

1. Create a new DESIGN.md alongside the old one
2. Run diff to catalog every change
3. Verify WCAG compliance for the new palette
4. Update code references to point to the new DESIGN.md
5. Archive the old DESIGN.md with a date suffix

---

## 5. Reviewing a screen against the tokens

Token-level contrast is `lint`'s job (§3.1). Everything else about a rendered
screen is a measurement, and `visual-validator` owns the measurements: hand it
the screenshot and the drift table becomes a set of findings rather than an
impression. Read the image first; [`_shared/inspect-image.md`](../_shared/inspect-image.md)
says how to get the pixels in front of you when the harness has no image tool
of its own.

What only you can answer, once the screen is measured:

1. Do the reported colors map to your palette, or did someone add a colour the
   file does not name?
2. Do detected typefaces and sizes match your typography tokens?
3. Do the gaps follow your spacing scale, or is there a fourth value nobody
   wrote down?
4. Every discrepancy is an action item in the drift table (§3.3).

---

## 6. Anti-Patterns

| Anti-pattern                        | Why it fails                                 | Instead                               |
| ----------------------------------- | -------------------------------------------- | ------------------------------------- |
| Tokens without prose                | No rationale - future agents guess at intent | Always explain WHY behind each token  |
| Prose without tokens                | No exact values - agents invent their own    | Always include YAML token definitions |
| Over-specified palette (>15 colors) | Hard to maintain, confusing                  | Keep core to 8-12 colors max          |
| No component tokens                 | Agents invent component styles               | Define buttons, cards, inputs minimum |
| Only light mode                     | Dark mode is left to chance                  | Define surface variants for dark mode |
| No on-\* colors                     | Text readability not guaranteed              | Every color needs an on-color         |
| Changing token names                | Breaks references everywhere                 | Names are permanent; values change    |
| Zero documentation of drift         | Inconsistencies compound silently            | Use lint + diff regularly             |

### Dark mode tokens

The "only light mode" anti-pattern has a concrete answer: a second set of
surface tokens, not a filter over the first.

```yaml
colors:
  surface: "#F9F9FF" # light: the page
  on-surface: "#151C27"
  surface-dim: "#111318" # dark: the page
  on-surface-dark: "#E3E6EB"
  surface-container: "#E7EEFE"
  surface-container-dark: "#1D2024"
  inverse-surface: "#2F3033" # used for snackbars in both modes
  inverse-on-surface: "#F1F0F4"
```

Keep the semantic names stable across modes and change only the values; lint's
`contrast-ratio` rule then checks both sets with the same call.

---

## Quick Reference

| Action           | Command                                                                     | What to do with the output                                                    |
| ---------------- | --------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Validate         | `npx @google/design.md lint DESIGN.md`                                      | Fix errors; read warnings as drift, not noise                                 |
| Check contrast   | the same command                                                            | Report the ratio the finding carries; do not eyeball it                       |
| Compare versions | `npx @google/design.md diff OLD.md NEW.md`                                  | Every modified token is a migration item; `regression: true` blocks the merge |
| Export tokens    | `npx @google/design.md export --format <json-tailwind\|css-tailwind\|dtcg>` | Commit the generated file; never hand-edit it                                 |
| Review a screen  | `visual-validator`, after reading the image as an attachment                | Findings become drift-table rows                                              |
| Learn the rules  | `npx @google/design.md spec --rules`                                        | The rule list is the source of truth for a custom lint                        |

The DESIGN.md format is documented at [Google's design-spec repository](https://github.com/google-labs-code/design.md).
