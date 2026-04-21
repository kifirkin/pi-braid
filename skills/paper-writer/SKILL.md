---
name: paper-writer
description: "Use when structuring, writing, or formatting LaTeX-based LLM research papers for arXiv. Covers IMRaD structure, academic tone, literature synthesis, methodology definition, and result interpretation."
---

# Paper Writer

LaTeX-based research paper generation for arXiv, following standard ML conventions.

---

## IMRaD Structure

| Section | Content |
|---------|---------|
| **Abstract** | Problem + Approach + Key Result |
| **Introduction** | Context → Gap → Proposed Solution → Contributions |
| **Related Work** | Organize by theme, not paper-by-paper |
| **Methodology** | LaTeX math environments (align, equation) |
| **Experiments** | Hyperparameters and data detail |
| **Conclusion** | Summary + Future Work |

---

## Core Competencies

1. **Structure & Formatting** — `\documentclass{article}` or `neurips`/`icml` styles, correct metadata, abstract, sectioning
2. **Academic Tone** — Precise, formal, objective English. No marketing language.
3. **Literature Synthesis** — Relevant citations based on keywords (prioritize top-tier AI conferences/arXiv)
4. **Methodology Definition** — Rigorous definitions of models, datasets, evaluation metrics
5. **Result Interpretation** — Tables (`booktabs`) and graphs with analytical insights

---

## LaTeX Optimization

- Use `natbib` or `biblatex` for citations
- Use `\usepackage{booktabs}` for high-quality tables
- Define math commands for commonly used notation (e.g., $\mathcal{D}$ for dataset)
- All figures referenced in text (`~\ref{...}`)

---

## Workflow

### 1. Initial Setup
Create `main.tex`, `references.bib`, and a `/figures` directory. Cite (`\cite{}`) all empirical and factual claims.

### 2. Quality Control
- Consistent terminology throughout
- All figures referenced in text (`\ref{...}`)
- Length: 9 pages + unlimited references
