---
name: pi-braid
version: 1.0.0
created: 2026-04-30

# ─── Design Tokens ─────────────────────────────────────────────────────────

colors:
  # Primary — warm amber (action, trust, energy)
  primary:              "#855300"
  "on-primary":         "#FFFFFF"
  "primary-container":  "#FFDDB8"
  "on-primary-container": "#2A1700"

  # Secondary — sky blue (calm, reliable, intelligence)
  secondary:            "#0058BE"
  "on-secondary":        "#FFFFFF"
  "secondary-container": "#D4E3FF"
  "on-secondary-container": "#001A40"

  # Tertiary — deep teal (premium, depth, precision)
  tertiary:             "#00658B"
  "on-tertiary":        "#FFFFFF"
  "tertiary-container": "#B4E9FF"
  "on-tertiary-container": "#001F2B"

  # Surfaces — layered dark for depth
  surface:              "#1A1C1E"
  "surface-dim":        "#121416"
  "surface-bright":     "#2A2C2F"
  "surface-container":  "#212326"
  "surface-container-lowest":  "#0F1012"
  "surface-container-low":     "#181A1C"
  "surface-container-high":    "#2C2E32"
  "surface-container-highest": "#37393D"
  "surface-tint":       "#855300"

  # On-surface — warm near-white
  "on-surface":         "#E4E2DE"
  "on-surface-variant":  "#C4C1BB"
  "outline":            "#6E6A62"
  "outline-variant":    "#454340"

  # Background — darkest
  background:           "#121416"
  "on-background":      "#E4E2DE"

  # Semantic
  error:                "#FFB4AB"
  "on-error":           "#690005"
  "error-container":    "#93000A"
  "on-error-container": "#FFDAD6"

  success:              "#7DD99D"
  "on-success":         "#003919"
  "success-container":  "#005328"
  "on-success-container":"#B5F2C6"

  warning:              "#F0C06A"
  "on-warning":         "#422A00"
  "warning-container":  "#5F3D00"
  "on-warning-container":"#FDE0A4"

# ─── Typography ────────────────────────────────────────────────────────────

typography:
  display:
    fontFamily: "Plus Jakarta Sans"
    fontSize: 44px
    fontWeight: 800
    lineHeight: 52px
    letterSpacing: -0.02em

  headline-lg:
    fontFamily: "Plus Jakarta Sans"
    fontSize: 32px
    fontWeight: 700
    lineHeight: 40px
    letterSpacing: -0.01em

  headline-md:
    fontFamily: "Plus Jakarta Sans"
    fontSize: 24px
    fontWeight: 600
    lineHeight: 32px

  title-lg:
    fontFamily: "Plus Jakarta Sans"
    fontSize: 20px
    fontWeight: 600
    lineHeight: 28px

  title-md:
    fontFamily: "Plus Jakarta Sans"
    fontSize: 16px
    fontWeight: 600
    lineHeight: 24px

  body-lg:
    fontFamily: "Plus Jakarta Sans"
    fontSize: 16px
    fontWeight: 400
    lineHeight: 24px

  body-md:
    fontFamily: "Plus Jakarta Sans"
    fontSize: 14px
    fontWeight: 400
    lineHeight: 20px

  body-sm:
    fontFamily: "Plus Jakarta Sans"
    fontSize: 12px
    fontWeight: 400
    lineHeight: 16px

  label-lg:
    fontFamily: "Plus Jakarta Sans"
    fontSize: 14px
    fontWeight: 600
    lineHeight: 20px

  label-md:
    fontFamily: "Plus Jakarta Sans"
    fontSize: 12px
    fontWeight: 600
    lineHeight: 16px
    letterSpacing: 0.02em

  label-sm:
    fontFamily: "Plus Jakarta Sans"
    fontSize: 10px
    fontWeight: 600
    lineHeight: 14px
    letterSpacing: 0.04em

# ─── Spacing ──────────────────────────────────────────────────────────────

spacing:
  base:      8px
  xs:        4px
  sm:        8px
  md:       16px
  lg:       24px
  xl:       40px
  xxl:      64px
  xxxl:     96px

  gutter:   16px
  margin:   24px

# ─── Corner Radius ────────────────────────────────────────────────────────

rounded:
  sm:    4px
  md:    8px
  lg:   12px
  xl:   16px
  xxl:  24px
  full:  9999px

# ─── Elevation / Shadows ───────────────────────────────────────────────────

elevation:
  level0: "none"
  level1: "0 1px 2px rgba(0,0,0,0.3), 0 1px 3px rgba(0,0,0,0.15)"
  level2: "0 2px 4px rgba(0,0,0,0.25), 0 4px 8px rgba(0,0,0,0.15)"
  level3: "0 4px 8px rgba(0,0,0,0.2), 0 8px 16px rgba(0,0,0,0.15)"
  level4: "0 8px 16px rgba(0,0,0,0.2), 0 16px 32px rgba(0,0,0,0.15)"

# ─── Motion ────────────────────────────────────────────────────────────────

motion:
  duration-fast:      150ms
  duration-normal:    250ms
  duration-slow:      400ms
  easing-standard:    "cubic-bezier(0.2, 0, 0, 1)"
  easing-decelerate:  "cubic-bezier(0, 0, 0.2, 1)"
  easing-accelerate:  "cubic-bezier(0.4, 0, 1, 1)"

---

## Overview

pi-braid is a cognitive extension layer for the pi coding agent. The brand identity reflects its core values: **precision**, **depth**, and **systematic intelligence**.

**Personality**: methodical but approachable. Like a senior engineer who documents everything and never leaves a TODO without context.

**Visual metaphor**: a braid — each extension strand is distinct, but together they form something stronger than the sum of parts.

**Colors**: warm amber (primary) for action and trust. Cool blue (secondary) for calm intelligence and reliability. Dark surfaces with subtle warm undertones — not cold black, not gray. The warmth says "human," the darkness says "depth."

**Typography**: Plus Jakarta Sans throughout — modern, highly legible, works from 10px captions to 44px display text. No serif, no mono for brand text.

---

## Color Philosophy

### Primary — Amber `#855300`

The amber is the action color. It appears on:
- **Primary buttons** (solid amber background)
- **Active states** (current selection, focus ring)
- **Progress indicators** (working, processing)
- **pi-braid logo** and key brand marks

The amber says "this is where the energy is." It is never used for decoration alone — every amber element has a functional purpose.

### Secondary — Blue `#0058BE`

Blue is the intelligence color. It appears on:
- **Secondary buttons** (outlined or container style)
- **Informational states** (context hints, tooltips)
- **Links** within text
- **Agent state indicators** (thinking, planning)

Blue balances amber's warmth with cool precision. Together they create a system where action (amber) and analysis (blue) are visually distinct.

### Surface System

pi-braid lives in a terminal environment. Surfaces are layered dark grays, not flat black. The warmth in the `on-surface` color (`#E4E2DE`) prevents the cold sterility of pure white-on-black.

| Surface | When to use |
|---------|-------------|
| `surface-dim` `#121416` | Page/app background — the deepest layer |
| `surface` `#1A1C1E` | Primary card/container background |
| `surface-container` `#212326` | Nested containers, sidebar backgrounds |
| `surface-bright` `#2A2C2F` | Hover states, elevated elements |

### Semantic Colors

| Token | Hex | Usage |
|-------|-----|-------|
| `error` | `#FFB4AB` | Error text on dark surfaces |
| `success` | `#7DD99D` | Confirmations, success messages |
| `warning` | `#F0C06A` | Caution, attention-needed |

All semantic colors have adequate contrast against their backgrounds (≥4.5:1 for text, ≥3:1 for UI components).

---

## Typography System

**Font**: Plus Jakarta Sans — chosen for:
- Excellent legibility from 10px to 44px
- Natural weight variation (400–800) without optical compensation issues
- Modern, professional character without being generic
- No optical size axis issues

**Scale ratio**: 1.25 (major third). Each step is 25% larger than the previous.

**Never use**: system fonts as fallback (they vary wildly), multiple font families in the same context, weight below 400 for body text.

### Type Usage

| Token | Application |
|-------|-------------|
| `display` | Hero text, agent output headers, splash screens |
| `headline-lg` | Section titles, major headings |
| `headline-md` | Card titles, subsection headings |
| `title-lg` | Navigation labels, large buttons |
| `title-md` | Form labels, secondary headings |
| `body-lg` | Primary reading text, agent responses |
| `body-md` | Secondary text, metadata, captions |
| `label-lg` | Button text, interactive labels |
| `label-md` | Badges, tags, small metadata |
| `label-sm` | Timestamps, line numbers, tiny labels |

### Accessibility

- Minimum body text: `14px` at `400` weight — never smaller
- Line height: `1.4`–`1.5` for body, `1.1`–`1.3` for headings
- All text passes WCAG AA (4.5:1 normal, 3:1 large)

---

## Spacing & Grid

**Base unit**: `8px`. Every spacing value is a multiple of 8 (or 4 for `xs`).

**Spacing scale**:
```
4  → xs  (icon margins, micro gaps)
8  → sm  (input padding, tight gaps)
16 → md  (card padding, component gaps)
24 → lg  (section spacing, card margins)
40 → xl  (page sections, hero padding)
64 → xxl (large separations, major layout gaps)
```

**Grid**: 4-column mobile, 8-column tablet, 12-column desktop. `gutter: 16px` throughout.

**Rule**: if a spacing value isn't in the scale, it doesn't exist. Add it to the scale first, then use it.

---

## Corner Radius

| Token | Value | Usage |
|-------|-------|-------|
| `rounded.sm` | 4px | Small inputs, chips, tight elements |
| `rounded.md` | 8px | Cards, buttons, standard containers |
| `rounded.lg` | 12px | Modals, large sheets, prominent elements |
| `rounded.xl` | 16px | Full-screen sheets, onboarding cards |
| `rounded.full` | 9999px | Avatars, pills, badges |

**Rule**: never use radii outside this scale. The radius should match the component's prominence — subtle for utilitarian, generous for interactive/emphasized.

---

## Components

### Buttons

```yaml
button-primary:
  backgroundColor: "{colors.primary}"
  textColor: "{colors.on-primary}"
  typography: "{typography.label-lg}"
  rounded: "{rounded.lg}"
  padding: "{spacing.md} {spacing.lg}"

button-primary-hover:
  backgroundColor: "{colors.primary-container}"
  textColor: "{colors.on-primary-container}"

button-secondary:
  backgroundColor: "{colors.secondary-container}"
  textColor: "{colors.on-secondary-container}"
  typography: "{typography.label-lg}"
  rounded: "{rounded.lg}"
  padding: "{spacing.md} {spacing.lg}"

button-ghost:
  backgroundColor: "transparent"
  textColor: "{colors.on-surface}"
  typography: "{typography.label-lg}"
  rounded: "{rounded.md}"
  padding: "{spacing.sm} {spacing.md}"
```

**Usage**: Primary for the main action. Secondary for alternate actions. Ghost for tertiary/destructive actions.

### Cards

```yaml
card:
  backgroundColor: "{colors.surface}"
  rounded: "{rounded.md}"
  padding: "{spacing.md}"
  elevation: "{elevation.level1}"
```

### Input Fields

```yaml
input:
  backgroundColor: "{colors.surface-container}"
  textColor: "{colors.on-surface}"
  typography: "{typography.body-md}"
  rounded: "{rounded.sm}"
  padding: "{spacing.sm} {spacing.md}"
  border: "1px solid {colors.outline}"

input-focused:
  border: "2px solid {colors.primary}"
```

### Status Badges

```yaml
badge-success:
  backgroundColor: "{colors.success-container}"
  textColor: "{colors.on-success-container}"
  typography: "{typography.label-sm}"
  rounded: "{rounded.full}"
  padding: "{spacing.xs} {spacing.sm}"

badge-error:
  backgroundColor: "{colors.error-container}"
  textColor: "{colors.on-error-container}"
  typography: "{typography.label-sm}"
  rounded: "{rounded.full}"
  padding: "{spacing.xs} {spacing.sm}"
```

---

## Do's and Don'ts

### Do
- Use amber for primary CTAs and active states
- Use blue for secondary actions, links, and informational elements
- Use surface containers to create visual hierarchy and depth
- Keep all text on dark surfaces at ≥4.5:1 contrast
- Apply rounded.md (8px) as the default corner radius

### Don't
- Use more than 2 accent colors (amber + blue is the system)
- Place amber on amber (no gradient overlays on buttons)
- Use surface-bright for large areas — it's for highlights, not backgrounds
- Apply rounded.xl or larger to small elements (feels bloated)
- Use pure black `#000000` anywhere — it breaks the warm-tint system

---

## Export Formats

This design system can be exported to:

```bash
# CSS custom properties
npx @google/design.md export --format css docs/DESIGN.md

# Tailwind config
npx @google/design.md export --format tailwind docs/DESIGN.md > tailwind.theme.js

# Design Token Community Group (DTCG) JSON
npx @google/design.md export --format dtcg docs/DESIGN.md > tokens.json
```

Validate: `npx @google/design.md lint docs/DESIGN.md`