---
name: design-system
description: "Design and maintain a brand identity system using the DESIGN.md format. Covers design tokens (colors, typography, spacing, components), brand consistency enforcement, visual identity documentation, and the full DESIGN.md authoring workflow. Activate when building a brand system, writing a DESIGN.md, or enforcing design consistency across a project."
validated: 2026-08-16
verdict: IMPROVE
---

# Design System & Brand Identity

Build and maintain a durable visual brand identity using the DESIGN.md format. The format is a monorepo that ships CLI tooling for linting, diffing, and exporting.

> **⚠️ CLI availability**: The `@google/design.md` CLI is aspirational - it's Google's internal design-spec tooling and has not been published as a public npm package. The commands shown below document the _intended_ interface. Until the package is published, use `describe_image` + manual cross-reference (see §5) for enforcement, and the token schema + drift-handling table for manual consistency checks.

---

## The DESIGN.md Format

A DESIGN.md file combines machine-readable design tokens (YAML front matter) with human-readable design rationale (markdown). Tokens give agents exact values. Prose tells them _why_ those values exist and how to apply them.

```
---
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

Every agent that reads this file will produce visuals consistent with this identity.

---

## 1. Token Schema Reference

### 1.1 Colors

```yaml
colors:
  <token-name>: <hex-color>
```

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

| Property                  | Allowed values                              |
| ------------------------- | ------------------------------------------- |
| `backgroundColor`         | Color hex or `{colors.xxx}` token reference |
| `textColor`               | Color hex or `{colors.xxx}` token reference |
| `typography`              | `{typography.xxx}` token reference          |
| `rounded`                 | Dimension or `{rounded.xxx}` reference      |
| `padding`                 | Dimension or `{spacing.xxx}` reference      |
| `size`, `height`, `width` | Dimension                                   |

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

```yaml
spacing:
  base: 8px
  xs: 4px; sm: 12px; md: 24px; lg: 40px; xl: 64px
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

---

## 3. Consistency Enforcement

### 3.1 Consistency Enforcement (No CLI Yet)

Until the `@google/design.md` CLI is published, enforce DESIGN.md consistency manually per §3.2 below. The intended (future) commands are:

```bash
# Lint a DESIGN.md for structural errors (aspirational)
npx @google/design.md lint DESIGN.md

# Compare two versions for regressions (aspirational)
npx @google/design.md diff DESIGN.md DESIGN-v2.md

# Export to other formats (aspirational)
npx @google/design.md export --format tailwind DESIGN.md > tailwind.theme.json
npx @google/design.md export --format dtcg DESIGN.md > tokens.json

# Get the spec for agent context (aspirational)
npx @google/design.md spec --rules
```

### 3.2 Cross-Screen Consistency Check

When verifying that a screen follows the DESIGN.md:

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
3. Run `describe_image` on screenshots and cross-reference against DESIGN.md tokens
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

Then run a diff check - either manually or via the aspirational `npx @google/design.md diff DESIGN.md DESIGN-v2.md` - to verify only intentional changes.

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

## 5. Integration with describe_image

After building a DESIGN.md, use `describe_image` with a comprehensive comparison prompt on screenshots of implemented designs:

```
describe_image("screenshot.png", "Comprehensive design analysis: compare the implementation against the DESIGN.md tokens - colors, typography, spacing, component shapes - and list every deviation")
```

The analysis will report detected colors, typography, spacing, and components. Cross-reference these against the DESIGN.md tokens:

1. Extract the reported colors - do they match your DESIGN.md palette?
2. Extract detected typefaces - do they match your DESIGN.md typography?
3. Extract spacing patterns - do they follow your DESIGN.md scale?
4. Note any discrepancies as action items.

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

---

## Quick Reference

| Action                | How to do it (today)                                   | Aspirational CLI               |
| --------------------- | ------------------------------------------------------ | ------------------------------ |
| Validate structure    | Manual review or `yaml-lint` on YAML front matter      | `npx @google/design.md lint`   |
| Compare versions      | Manual diff or `file_diff` between two DESIGN.md files | `npx @google/design.md diff`   |
| Export to Tailwind    | Copy-paste tokens into `tailwind.config.js`            | `npx @google/design.md export` |
| Export to DTCG        | Copy-paste tokens into DTCG format                     | `npx @google/design.md export` |
| Analyze visual output | `describe_image("screenshot.png", prompt)`             | -                              |
| Validate output       | Follow visual-validator audit format                   | -                              |

The DESIGN.md format is documented at [Google's design-spec repository](https://github.com/google/design.md).
