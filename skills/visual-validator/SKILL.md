---
name: visual-validator
description: "Rigorous visual validation with professional design critique. Analyzes sprite assets, game screenshots, UI designs, and any visual content with designer-level feedback and actionable fixes with measurable deltas."
---

# Visual Validator

Professional design critique with evidence-based, actionable fixes.

---

## Universal Measurements

Always extract for any visual asset:

| Metric | Value |
|--------|-------|
| Dimensions | {width}×{height}px |
| Aspect Ratio | {ratio}:1 |
| Dominant Colors | Top 5 hex codes with % |
| Information Density | high/medium/low |
| Layout Quadrants | Q1-Q4 element summary |

---

## The Audit Format

```markdown
## DESIGN AUDIT: [filename]

### 1. OVERALL ASSESSMENT
[One sentence professional verdict]

### 2. GESTALT ANALYSIS
| Principle | Status | Evidence |
|-----------|--------|----------|
| Silhouette Readability | ✅/⚠️/❌ | [Measured evidence] |
| Figure-Ground | ✅/⚠️/❌ | [Measured evidence] |
| Form Continuity | ✅/⚠️/❌ | [Measured evidence] |
| Visual Weight Balance | ✅/⚠️/❌ | [Measured evidence] |
| Proportion | ✅/⚠️/❌ | [Measured evidence] |

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

## Design Vocabulary

| Term | Definition | Application |
|------|------------|-------------|
| **Silhouette** | Outline shape | "Readable at 16×16px" |
| **Gestalt** | Whole > parts | "Perceives character despite stacking" |
| **Figure-ground** | Subject vs background | "Blue pops from dark" |
| **Visual weight** | Attention drawn | "Eye dominates 40% of head" |
| **Rhythm** | Repeated elements | "Quill pattern creates spine rhythm" |
| **Negative space** | Space between elements | "Gap creates form" |
| **Tension** | Visual energy | "Forward lean creates movement" |

---

## Sprite Critique Criteria

| Aspect | Check | Pass |
|--------|-------|------|
| **Silhouette** | Distinct profile at small scale | Readable at 16×16px |
| **Proportion** | Head-to-body ratio | ±5% of target |
| **Perspective** | Consistent view angle | 3/4 side or true side |
| **Form Continuity** | No floating/detached parts | Arms at shoulders |
| **Detail Placement** | Key features in correct positions | Eye forward, quills behind |

---

## Animation State Critique

| State | Check | Target |
|-------|-------|--------|
| **Keyframes** | Minimum viable frames | idle: 2, walk: 3, run: 4 |
| **Weight Shift** | Body leans into movement | run: 15-25° forward lean |
| **Cycle Integrity** | First and last frame match | Same pose, same position |
| **Limb Sync** | Arms and legs opposite phases | Left arm forward = Right leg forward |

---

## Integration

1. **CAPTURE** — `analyze_image` tool
2. **MEASURE** — Extract dimensions, colors, positions
3. **COMPARE** — `compare_images` (for reference comparison)
4. **AUDIT** — Apply design criteria
5. **TRIAGE** — P0/P1/P2 classification
6. **PRESCRIBE** — Specific actionable fixes

---

## Forbidden

- "Looks better" without measurement
- Vague advice without specific values
- Ignoring evidence of critical failure
- Accepting "close enough" when delta > tolerance
