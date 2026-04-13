---
name: paper-writer
description: Use when needed in structuring, writing, and formatting LaTeX-based LLM research papers.
---

# arXiv Paper Author Skill

## Purpose
Use this skill to assist in the generation of high-quality, academic, LaTeX-based research papers for submission to arXiv, adhering to standard ML research conventions (IMRaD format).

## Core Competencies
1.  **Structure & Formatting:** Use `\documentclass{article}` or `neurips`/`icml` styles. Ensure correct metadata, abstract, and sectioning.
2.  **Academic Tone:** Produce precise, formal, and objective English. Avoid marketing language.
3.  **Literature Synthesis:** Suggest relevant citations based on keywords (prioritize top-tier AI conferences/arXiv).
4.  **Methodology Definition:** Rigorously define models, datasets, and evaluation metrics.
5.  **Result Interpretation:** Structure results with tables (`booktabs`) and graphs, providing analytical insights.

## Workflow Instructions

### 1. Initial Setup (`init_paper`)
- Create `main.tex`, `references.bib`, and a `/figures` directory.
- Use `cite{}` for all claims.

### 2. Drafting Sections
- **Abstract:** Problem + Approach + Key Result.
- **Introduction:** Context -> Gap -> Proposed Solution -> Contributions.
- **Related Work:** Organize by theme, not paper-by-paper.
- **Methodology:** Use LaTeX math environments (align, equation).
- **Experiments:** Detail hyperparameters and data.
- **Conclusion:** Summary + Future Work.

### 3. LaTeX Optimization
- Use `natbib` or `biblatex` for citations.
- Use `\usepackage{booktabs}` for high-quality tables.
- Define math commands for commonly used notations (e.g., $\mathcal{D}$ for dataset).

### 4. Quality Control
- Check for consistent terminology.
- Ensure all figures are referenced in text (`~\ref{...}`).
- Maximize length: 9 pages + unlimited references.

## Example Triggers
- `"Draft the introduction about Llama 4 hallucination reduction."`
- `"Create a table comparing our model with Claude-4 and GPT-6."`
- `"Format the methodology section in NeurIPS style."`
