---
name: visual-creator
description: "Use when a page, screen, game UI or marketing asset looks generic, flat, cheap or dated, or when its palette, type scale, spacing rhythm or hierarchy is still undecided and everything is the same size and weight. Chooses those identity decisions before anything is built. Not for judging a finished render (visual-validator), not for writing the token file (design-system), and not for landing-page mechanics (landing-page)."
validated: 2026-10-27
verdict: IMPROVE
governs:
  - design
triggers:
  - ui layout
  - color palette
  - type scale
  - spacing
  - spacing grid
  - visual hierarchy
  - game ui
  - poster
  - brand asset
  - design composition
  - sprite
---

# Visual Creator

Create visuals that stand up to professional critique. This skill pairs with visual-validator: create first, then validate.

---

## The loop, and this skill's place in it

`visual-validator` owns the design loop: measure with `design_audit`, decide the
identity in writing, build, re-measure, compare. This skill is its **decide**
step - the palette, type scale, spacing rhythm and hierarchy are the decisions
that loop writes down before anything is built. The loop lives in that file;
follow it from there.

Two of the ruler's outputs are yours to set and to defend:

- **`inventory`** - the distinct `fontSizes`, `fontWeights`, `lineHeights`,
  `spacings`, `radii` and `shadows` in use, each with `count`, `onGrid` and
  `inTokens`. An intentional scale is a short list with high counts; a soup is
  twenty values at count 1.
- **`colors[].coverage`** (and `coverageTotal`) - the share of the page each
  painted colour owns. A dominant surface, a secondary band and an accent should
  show up as unequal percentages. Four colours at roughly 22% each is an even
  soup with no hierarchy, whatever the palette looks like in isolation.

Run the audit at its defaults (320, 390, 768, 1440) before you decide:

```
design_audit(target: "<url-or-file>")
```

The scale you choose is then the one the render needs, and the same call runs
again after you build.

### How the artifact gets made

This skill chooses constraints; it does not render. Name the route you have
before you start, because the choice changes the constraints:

- **An image model** in your toolset: prompt it, then read the result back.
- **HTML or SVG plus a headless screenshot**: fastest for UI, exact for type.
- **A plotting library**: for charts and diagrams (see the figure rules in
  `paper-writer`).
- **A file the user supplies**: audit it, do not regenerate it.

Whichever route you use, the last step is the same: get the pixels in front of
you and look. [`_shared/inspect-image.md`](../_shared/inspect-image.md) says how
when the harness ships no image tool.

---

## 1. Universal Design Principles

These apply to every visual domain. Internalize them.

### 1.1 Hierarchy: Make the Important Loud

| Technique        | How                         | Application                              |
| ---------------- | --------------------------- | ---------------------------------------- |
| Size contrast    | Largest = most important    | Headlines > subheads > body > captions   |
| Weight contrast  | Bold > regular > light      | Primary actions > secondary > tertiary   |
| Color saturation | Bright > muted > neutral    | CTAs use accent; backgrounds recede      |
| Spatial position | Top-left / center = primary | Hero section first, footer last          |
| Isolation        | Alone = important           | A single button with generous whitespace |

**Rule**: If two elements compete for attention, one is wrong. Decide which matters more and make it clearly dominant.

### 1.2 Alignment: Create Order

- **One alignment axis per container**: pick left, center, or right - mixing creates chaos
- **Grid alignment**: every element should snap to something
- **Baseline alignment**: text on different rows should share a baseline rhythm
- **Edge alignment**: card edges, image edges, and text boundaries should form clean lines

**Rule**: If an element is off-grid by less than 50% of your spacing unit, snap it. If more, it's intentional.

### 1.3 Contrast: Ensure Legibility

- **Text on background**: minimum 4.5:1 for body text (WCAG AA), 3:1 for large text
- **Adjacent colors**: at least 30% perceptual difference between adjacent regions
- **Interactive vs static**: interactive elements should look different from static ones
- **Hierarchy through contrast**: use weight, size, AND color contrast together, never one alone

### 1.4 Repetition: Build Consistency

- **Spacing rhythm**: use a consistent scale (4, 8, 12, 16, 24, 32, 48, 64px)
- **Corner radius**: 2-3 radii max for the entire system (e.g., sm=4, md=8, lg=12, full=9999)
- **Color reuse**: never use a color once - every color earns its place by appearing in multiple places
- **Component patterns**: similar things look similar; different things look different

### 1.5 White Space: Let Content Breathe

- **Macro space**: section padding, margins, gutters - use your spacing scale generously
- **Micro space**: padding inside cards, button internal padding, text line-height
- **Negative space**: empty areas between elements create visual structure - they're not wasted
- **Density calibration**: cut what the layout does not need. Compare the screen against a version with one third fewer elements; keep whichever reads faster. There is no universal percentage.

---

## 2. Color Theory & Palette Creation

### 2.1 Core Palette Structure

Every palette needs these roles:

| Role          | Purpose                      | Saturation      | Coverage |
| ------------- | ---------------------------- | --------------- | -------- |
| **Primary**   | Brand color, main actions    | Medium-high     | ~10-20%  |
| **Secondary** | Secondary actions, accents   | Medium          | ~5-10%   |
| **Tertiary**  | Rare accents, highlights     | High or low     | ~2-5%    |
| **Neutral**   | Backgrounds, text, borders   | Low (near-gray) | ~60-70%  |
| **Surface**   | Containers, cards, modals    | Very low        | varies   |
| **Error**     | Destructive actions, errors  | High red        | <1%      |
| **Success**   | Confirmations, active states | Medium green    | <1%      |
| **Warning**   | Alerts, caution              | Medium amber    | <1%      |

### 2.2 Palette Generation Rules

- **Start from a single source**: pick one hero color, derive everything else
- **Use HSL**: pick hue first, then tune saturation and lightness
- **Palette depth**: each color gets at least 4 stops (50/100/200/.../900 or container/on-container/fixed-dim)
- **Neutral temperature**: match neutrals to your primary hue temperature (warm primary → warm grays)
- **Contrast guarantees**: ensure on-primary vs primary passes WCAG AA (4.5:1). If not, adjust lightness
- **Accent contrast**: accent colors should contrast with both the primary and neutral palettes

### 2.3 Color Harmony Reference

| Scheme              | Structure                       | Best For              | Pitfall                            |
| ------------------- | ------------------------------- | --------------------- | ---------------------------------- |
| Monochromatic       | Single hue, varying L/S         | Minimalist, data viz  | Can feel flat without texture      |
| Analogous           | Adjacent hues (30-60°)          | Calm, cohesive brands | Low energy, needs contrast         |
| Complementary       | Opposite hues (180°)            | High energy, games    | Can be jarring if equal saturation |
| Split-complementary | Base + 2 adjacent to complement | Most UI               | Safe, versatile, rarely wrong      |
| Triadic             | 3 evenly spaced (120° apart)    | Bold, creative        | Hard to balance saturation         |
| Tetradic            | 2 complementary pairs           | Rich, complex         | High risk of chaos                 |

**For UI, start with split-complementary or analogous + one accent. For games, complementary or triadic.**

### 2.4 WCAG Compliance Checklist

- Text on solid background: ≥4.5:1 (AA normal), ≥3:1 (AA large), ≥7:1 (AAA normal)
- Non-text contrast (UI components, icons): ≥3:1 against adjacent colors
- Focus indicators: ≥3:1 contrast against unfocused state
- Color information: never rely solely on color - add icons, patterns, or labels

---

## 3. Typography Systems

### 3.1 Type Scale

Build a modular scale. Good starting points:

| Step    | Size (rem)         | Weight  | Application                     |
| ------- | ------------------ | ------- | ------------------------------- |
| Display | 2.5-3.5 (40-56px)  | 700-800 | Hero headlines, splash screens  |
| H1      | 2.0-2.5 (32-40px)  | 600-700 | Page titles                     |
| H2      | 1.5-2.0 (24-32px)  | 600     | Section headers                 |
| H3      | 1.25-1.5 (20-24px) | 600     | Card titles                     |
| Body    | 1.0 (16px)         | 400     | Primary reading                 |
| Body-sm | 0.875 (14px)       | 400     | Secondary text, metadata        |
| Caption | 0.75 (12px)        | 400-500 | Labels, timestamps, small print |

**Scale ratio**: 1.25 (major third) or 1.333 (perfect fourth). Pick one and use it.

### 3.2 Font Pairing

| Pairing Style        | Headline Font                    | Body Font               | Vibe                         |
| -------------------- | -------------------------------- | ----------------------- | ---------------------------- |
| Classic serif + sans | Serif (Playfair, Merriweather)   | Sans (Inter, Open Sans) | Editorial, trustworthy       |
| Modern sans + sans   | Display sans (Plus Jakarta Sans) | Workhorse sans (Inter)  | Contemporary, clean          |
| Mono accent + sans   | Monospace (JetBrains Mono)       | Sans (Inter)            | Technical, developer-focused |
| Single family        | Same family, different weights   | Same family             | Safe, consistent, scalable   |

**Rules**: never use more than 2 typefaces. Never pair two serifs or two display fonts. Use weight variation within a family before reaching for a second family.

### 3.3 Readability Engineering

- **Line length**: 45-75 characters per line (optimal: 66)
- **Line height**: 1.5 for body text, 1.1-1.3 for headings
- **Paragraph spacing**: 1× the line height (so 24px gap for 16px/1.5 body)
- **Measure**: on wide screens, cap max-width of text containers to ~700px
- **Hierarchy enforcement**: heading vs body size ratio should be ≥1.5× (never 1.25× or less)

---

## 4. Layout & Composition

### 4.1 Grid Systems

| Grid Type     | Structure                     | Best For                             |
| ------------- | ----------------------------- | ------------------------------------ |
| Single column | 1 column, max-width container | Articles, reading-focused            |
| 2-column      | Sidebar + main                | Dashboards, docs                     |
| 4-column      | 4 equal cols (mobile)         | Mobile-first apps                    |
| 12-column     | 12 flexible cols              | Desktop-first, complex layouts       |
| Card grid     | Rectangular cells with gap    | Galleries, product lists, dashboards |
| Full bleed    | Edge-to-edge                  | Marketing, hero sections, games      |

### 4.2 Spacing Scales

Pick one scale and use it everywhere:

| Name         | Base | Scale                                    |
| ------------ | ---- | ---------------------------------------- |
| **4px grid** | 4px  | 4, 8, 12, 16, 20, 24, 32, 40, 48, 64, 80 |
| **8px grid** | 8px  | 8, 16, 24, 32, 40, 48, 64, 80, 96, 128   |
| **Modular**  | 8px  | 8, 12, 16, 24, 36, 48, 72, 96, 144       |

**Recommendation**: use 8px grid for web UI (it divides cleanly into 4 for fine-tuning). Use 4px for game UI where pixel-precision matters.

### 4.3 Composition Laws

- **Rule of thirds**: key elements on intersection lines or lines themselves
- **Golden ratio (1.618:1)**: use for aspect ratios (16:10 ≈ 1.6 is close), image crops, section proportions
- **F-pattern**: for text-heavy layouts, align important content to top-left and left edge
- **Z-pattern**: for promotional layouts, place key elements on the Z path (top-left → top-right → bottom-left → bottom-right)
- **Visual weight balance**: a large light element balances a small dark one at equal distance from center

### 4.4 Responsive Breakpoints (Web)

| Breakpoint | Width       | Layout                     |
| ---------- | ----------- | -------------------------- |
| Mobile     | < 640px     | 4 columns, single-panel    |
| Tablet     | 640-1024px  | 8 columns, two-panel       |
| Desktop    | 1024-1440px | 12 columns, multi-panel    |
| Wide       | > 1440px    | 12 columns + max-width cap |

---

## 5. Domain-Specific Guidance

### 5.1 Web / UI Design

**Patterns that work:**

- **Cards**: consistent internal padding (use spacing scale), rounded corners, subtle shadow, 1:1 or 4:3 aspect ratio for images
- **Navigation**: max 5-7 items in top nav; more → use dropdown, hamburger, or sidebar
- **Forms**: label above input, left-aligned labels, button right-aligned at bottom
- **Data tables**: zebra striping, sticky header, right-align numbers, left-align text
- **Buttons**: min 44px height, 16px horizontal padding, describe action (not "Submit" - "Save Changes")
- **Empty states**: illustration + message + CTA - never show a blank area

**What to avoid:**

- **Infinite scroll for content that benefits from search**: use pagination
- **Modal overlays for complex forms**: use dedicated page instead
- **Carousels for critical content**: users don't scroll through them
- **Hamburger menu + tab bar simultaneously**: choose one navigation paradigm
- **Ghost buttons as primary CTA**: primary actions need solid backgrounds

### 5.2 Game Design (UI & Assets)

**UI for games:**

- **Diegetic UI**: elements exist in the game world (character health bar on the character)
- **Non-diegetic**: classic HUD overlay (health bar at screen edge)
- **Menu hierarchy**: splash → main menu → settings/play → game → pause → results
- **Color in games**: use color for factions, rarity (common=gray, rare=blue, epic=purple, legendary=gold), damage types
- **Touch controls (mobile)**: minimum 48×48px, 8px+ gap between buttons, provide visual feedback on press

**Character sprites:**

- **Readable silhouette**: test at 16×16px scale - can you identify the character?
- **Proportions**: maintain consistent head-to-body ratio across all sprites
- **Animation**: minimum viable frames - idle: 2, walk: 4, run: 6, attack: 4
- **Palette constraints**: limit to 8-16 colors per character for retro, 16-32 for modern indie
- **Style consistency**: same line weight, same shading technique, same level of detail

**Environments:**

- **Depth layers**: background → middleground → foreground (parallax-ready)
- **Tileable textures**: edges meet without visible seams (test by tiling 3×3)
- **Color script**: guide player mood through color (warm = safe, cool = dangerous, dark = mystery)

### 5.3 Brand / Marketing Materials

- **Consistency > novelty**: a predictable brand beats a surprising one
- **Logo applications**: provide dark bg, light bg, monochrome, icon-only, and horizontal/stacked versions
- **Clear space**: minimum 1× the logo height/width around the logo - nothing intrudes
- **Typography lockup**: define which fonts go with the logo and how they align
- **Color restrictions**: define when to use full color vs single color vs grayscale
- **Photography style**: consistent lighting, color grade, and subject treatment

### 5.4 Diagrams & Information Design

- **Visual hierarchy in diagrams**: most important concept = center or top, largest and boldest
- **Flow direction**: left-to-right or top-to-bottom, consistent arrows, no crossing lines
- **Legend placement**: top-right or bottom-left, same visual style as the diagram
- **Color meaning**: consistent throughout - red = error/stop, green = success/go, blue = information
- **White space**: don't cram - leave 1-2× the element size between diagram nodes

---

## 6. Working inside the loop

The loop itself is `visual-validator`'s (see The loop, above): measure, decide,
build, re-measure, compare. This skill's work happens in its decide and build
steps; these are the moves that belong to them.

### Step 1: Decide, before anything is built

1. Define the design constraints: palette size, grid, spacing scale, type step.
2. Write them down (§2), and hand them to `design-system` when the project keeps
   a DESIGN.md other sessions follow.

### Step 2: Create

1. Build a single component or screen against those constraints.
2. Document the decisions inline where the value is not obvious.

### Step 3: Analyze

Read the render as an image attachment and compare it against the constraints
you wrote down in Step 1. Extract colors, layout, and typography; every
discrepancy between intent and output is a finding. The route to the pixels is
in [`_shared/inspect-image.md`](../_shared/inspect-image.md).

### Step 4: Compare, then improve

Run the same `design_audit` and paste the before/after table. Every row that
moved the wrong way is the next change; every row that did not move is a
decision you did not make. Fix P0 and P1 findings in the same session; keep a
P2 list or drop it, never carry it as debt.

### Iterations

Expect more than one pass and fewer than five. The first pass finds the P0s
(wrong scale, unreadable contrast); the second finds the P1s. If a third pass
turns up a P0, the constraints were wrong, not the execution: go back to Step 1
and rewrite them. And more passes do not make an identity: when the numbers are
clean and the three-decision check in `visual-validator` fails, the palette and
scale were never decided - Step 1 again.

### Boundaries

- **`design-system`** writes and enforces the token contract, the DESIGN.md file.
- **`visual-validator`** owns the loop: it measures a finished image, reports findings, and owns the before/after comparison.
- **This skill** chooses the palette, scale, and composition before anything exists. If you find yourself auditing a screenshot here, you are in the wrong file.

---

## 7. Anti-Patterns

These produce mediocre visuals every time:

| Anti-pattern                   | What happens                       | Instead                               |
| ------------------------------ | ---------------------------------- | ------------------------------------- |
| Starting with code             | No design reasoning, inconsistent  | Define palette + spacing first        |
| Single font at different sizes | No hierarchy, flat                 | Use weight + size + family contrast   |
| Random spacing                 | Layout feels "off" by a few pixels | Use a strict spacing scale            |
| Too many colors                | Muddy, unprofessional              | Limit to 3-5 hues with stops          |
| Centering everything           | No edge alignment, no structure    | Align to a grid, use center sparingly |
| Gradient overload              | Cheap, dated look                  | Use solid colors, flat design first   |
| Ignoring mobile                | Desktop-only that breaks           | Design mobile-first, scale up         |
| Making it up as you go         | Inconsistent, unrepeatable         | Define system first, then apply       |
| "I'll fix it later"            | Never gets fixed, accumulates debt | Fix P0/P1 in current cycle            |

---

## Integration

1. **MEASURE** - `design_audit` on the unchanged artifact
2. **DECIDE** - palette, type scale, spacing rhythm, hierarchy (this file)
3. **BUILD** - the smallest set of changes that serves those decisions
4. **RE-MEASURE / COMPARE** - same instrument, same widths, pasted table
5. **CHECK** - three decisions visible in the render; if not, the constraints
   were never decided
