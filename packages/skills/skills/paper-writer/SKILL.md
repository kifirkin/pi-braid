---
name: paper-writer
description: "Use when drafting or revising a paper for an ML venue, a workshop, or arXiv: sections, abstract, related-work framing, tables and figures, LaTeX preamble, citation conventions. Gives the IMRaD skeleton, the pre-submission checklist, and the venue facts that change every cycle (page limits, template names) as a lookup recipe rather than a table. Not for literature search (research) and not for prose voice (tone-quality)."
validated: 2026-10-27
verdict: IMPROVE
triggers:
  - write a paper
  - paper
  - latex
  - arxiv
  - neurips
  - icml
  - iclr
  - camera-ready
  - related work
  - conference submission
  - workshop paper
---

# Paper Writer

LaTeX-based research paper generation for ML/AI, following standard conference conventions.

---

## 1. The Full Workflow

```
OUTLINE → ABSTRACT → INTRODUCTION → RELATED WORK → METHOD → EXPERIMENTS → CONCLUSION → FIGURES → FINALIZE
```

Each pass tightens the argument. Write the abstract last - it's a distillation, not a starting point.

---

## 2. IMRaD Structure with Section-Level Guidance

### Abstract (Write Last)

The abstract is the most-read paragraph in the paper. It must be self-contained.

```
Template: Problem → Gap → Approach → Key Result → Implication
```

| Component   | What to include                               | Length      |
| ----------- | --------------------------------------------- | ----------- |
| Problem     | One sentence: what problem and why it matters | 1 clause    |
| Gap         | What existing work misses                     | 1 clause    |
| Approach    | Your method in 1-2 sentences                  | 1-2 clauses |
| Key result  | Quantitative claim with metric                | 1 sentence  |
| Implication | Why this matters beyond the numbers           | 1 clause    |

**Rules:**

- No citations in the abstract
- No undefined acronyms
- No math that requires parsing
- If the reader reads nothing else, they should know the contribution

### Introduction

Four paragraph structure:

1. **Context**: What's the broad problem? Who cares?
2. **Narrowing**: What specific subproblem is unsolved? What did prior work try?
3. **Our approach**: High-level sketch of what you did. Why it's different.
4. **Contributions**: Bulleted list of 3-5 concrete claims. Each must be verifiable from the paper.

```latex
\section{Introduction}

% Paragraph 1: Context
Recent advances in~\dots have shown~\dots However, existing methods fail when~\dots

% Paragraph 2: Gap
A key limitation is that~\dots This is particularly problematic for~\dots

% Paragraph 3: Our approach
In this work, we propose~\dots Unlike prior approaches, our method~\dots

% Paragraph 4: Contributions
Our contributions are:
\begin{itemize}
    \item A novel architecture that~\dots
    \item Empirical results showing~\dots
    \item Open-source implementation at~\dots
\end{itemize}
```

### Related Work

Organize by **theme**, not by paper-per-paragraph. Each theme addresses a different aspect of the gap.

| Theme structure | Example                                                                                                  |
| --------------- | -------------------------------------------------------------------------------------------------------- |
| Topic A         | "Several works address X. Method 1 does A, Method 2 does B. Both assume C - we address non-C scenarios." |
| Topic B         | "On the Y front, prior work focuses on D. Our setting differs in E."                                     |

**Rules:**

- Group 3-5 related papers per paragraph
- Lead with the approach, not the author
- End each paragraph by stating what's missing (your gap)
- Include at least one negative result: "Method X attempted this but found Y"
- Position your work as filling a specific, named gap - not as the only approach that exists

### Method

The most cited section of your paper. Structure:

```latex
\section{Method}

\subsection{Problem Formulation}
Setup, notation, assumptions.

\subsection{Proposed Architecture / Algorithm}
The core idea. Include the main equation or algorithm block.

\subsection{Theoretical Analysis (optional)}
Convergence, complexity, optimality guarantees.

\subsection{Implementation Details}
Architecture choices, hyperparameters, training procedure.
```

**Equation quality checklist:**

- Every symbol defined on first use
- Consistent notation across sections
- Math uses `\mathcal`, `\mathbb`, `\mathbf` for clarity
- Equations are numbered and referenced in text (`\eqref{eq:loss}`)
- Variables are italic (`$x$`), vectors are bold (`$\mathbf{x}$`), sets are calligraphic (`$\mathcal{D}$`)

### Experiments

The section that proves your contributions are real.

```latex
\section{Experiments}

\subsection{Setup}
Datasets, baselines, metrics, hyperparameters.

\subsection{Main Results}
Primary comparison table. Your method wins on the main metric.

\subsection{Ablation Studies}
What happens when you remove each component.

\subsection{Qualitative Analysis}
Visualizations, case studies, failure analysis.
```

**Table design rules:**

- Use `booktabs` (no vertical rules, no double lines)
- Bold the best result in each row
- Include standard deviations
- Columns: Method | Metric 1 | Metric 2 | Metric 3
- Every table must be referenced in text before it appears
- Tables that span pages belong in appendix

**Figure design rules:**

- **Export vector, not raster.** `savefig('fig.pdf')` from matplotlib; no PNG in a camera-ready unless the source is a photograph.
- **Size the figure for its final width.** A two-column venue's column is roughly 3.25in and its text width roughly 5.5in. Set `figsize` to that width and the font size in points; the rendered label size is then whatever you set, instead of a wish.
- **One font family with the body text.** `matplotlib.rc('font', family='serif')` plus `mathtext.fontset='cm'` matches a LaTeX body.
- **Colorblind-safe palette, cited.** Use a published palette and cite it in the caption; do not invent one and call it safe.
- **Reference every figure and table from the text before it appears.**

### Experimental rigor

Reviewers reject on this more often than on prose. Before submission:

- **Seeds.** State how many runs, the metric's mean and standard deviation, and whether the std is over seeds or over folds.
- **Error bars.** Every headline number in a table either carries a variance or a sentence explaining why it does not.
- **Significance.** If you claim an improvement, name the test (paired bootstrap, Wilcoxon) and its result. "Consistently better" without a test is a claim the reviewer will discount.
- **Baselines.** Every baseline named in related work appears in a table, tuned with the same budget, or the omission is stated with a reason.
- **Negative results.** Report the metric you lose on, in the main table.

### Conclusion

Three paragraphs:

1. **Summary**: What you did, in 2-3 sentences. Connect back to the introduction.
2. **Limitations**: 1-2 honest limitations. Don't hide them - positioning limitations as future work builds trust.
3. **Future work**: 2-3 concrete directions. Not "more research needed" - "extend X to handle Y using Z".

---

## 3. LaTeX Conventions

### Preamble Template

```latex
\documentclass{article}
% For a venue submission, replace the line above with the venue's own class
% file: take it from the current CFP's starter template (see section 6), not
% from a paper you read and not from this file.

\usepackage[utf8]{inputenc}
\usepackage[T1]{fontenc}
\usepackage{microtype}
\usepackage{booktabs}
\usepackage{graphicx}
\usepackage{amsmath, amssymb}
\usepackage{hyperref}
\usepackage[numbers,sort&compress]{natbib}
\usepackage{algorithm}
\usepackage{algpseudocode}

% Common notation commands
\newcommand{\dataset}{\mathcal{D}}
\newcommand{\model}{\mathcal{M}}
\newcommand{\loss}{\mathcal{L}}
\newcommand{\expectation}[1]{\mathbb{E}\left[#1\right]}
\newcommand{\given}{\mid}

% Title
\title{[Short, descriptive title]}
\author{[Author names with affiliations]}

\begin{document}
\maketitle

\begin{abstract}
...
\end{abstract}
\end{document}
```

### Citation Strategy

```latex
% Prefer natbib
\usepackage[numbers,sort&compress]{natbib}

% Good citation patterns:
% Per author: \citet{goodfellow2014gan} showed that...
% Per work:   \citep{vaswani2017attention} demonstrated...
% Multiple:   Several works \citep{devlin2019bert, liu2019roberta, lan2020albert}...

% Conference abbreviations
% NeurIPS:      nips
% ICML:         icml
% ICLR:         iclr
% ACL:          acl
% EMNLP:        emnlp
% CVPR:         cvpr
% AAAI:         aaai
% arXiv:        arxiv (use with caution — not peer-reviewed)
```

**Bibliography rules:**

- Conference papers > arXiv preprints (prefer peer-reviewed)
- Include DOI when available
- Use BibTeX keys: `authorYYYYkeyword` (e.g., `vaswani2017attention`) <!-- doc-ref-exempt: BibTeX key placeholder -->
- For reproducibility, cite code repositories and dataset papers

### Algorithm Environments

```latex
\begin{algorithm}[t]
\caption{Training Procedure}
\label{alg:training}
\begin{algorithmic}[1]
\Require Dataset $\dataset$, learning rate $\eta$
\Ensure Trained model $\model$
\State Initialize $\model$
\For{epoch $= 1$ to $T$}
    \For{batch $\mathbf{x} \sim \dataset$}
        \State Compute loss $\loss(\model(\mathbf{x}))$
        \State $\model \gets \model - \eta \nabla \loss$
    \EndFor
\EndFor
\State \Return $\model$
\end{algorithmic}
\end{algorithm}
```

---

## 4. Writing Process

### Drafting Order

| Pass | What to write               | Why this order                                          |
| ---- | --------------------------- | ------------------------------------------------------- |
| 1    | Method + Experiments        | Core contributions - everything else serves these       |
| 2    | Introduction + Related Work | Frames the contribution for the reader                  |
| 3    | Conclusion                  | Now that you know what you did, summarize it            |
| 4    | Abstract                    | 15 minutes, final pass - distill the entire paper       |
| 5    | Figures + Tables            | Visual communication is half the paper                  |
| 6    | Title + Author list         | Last piece - the title is the hardest sentence to write |

### Review Criteria (Self-Check)

Before submission, verify:

- **Title**: Does it contain the key method term and the task? Is it under 15 words?
- **Abstract**: Can a reader in your field understand your contribution in 10 seconds?
- **Intro**: Does the last paragraph have a numbered list of contributions?
- **Related work**: Does each paragraph end with "this is the gap we fill"?
- **Method**: Is every symbol defined? Is the main equation numbered?
- **Experiments**: Does the main table have standard deviations? Are baselines fair?
- **Conclusion**: Are limitations stated honestly?
- **Figures**: Are they vector, sized for their final width, colorblind-safe, and referenced in text before they appear?
- **References**: Does every citation support the sentence it is attached to, and does every baseline named in a related-work claim appear in the experiments table?
- **Length**: Fits within page limit (typically 8 pages + references for NeurIPS/ICML)?

---

## 5. Common Mistakes & Anti-Patterns

| Mistake                   | Why it hurts                              | Fix                                                           |
| ------------------------- | ----------------------------------------- | ------------------------------------------------------------- |
| Overclaiming              | "First ever" is almost never true         | "To our knowledge, the first" - and verify                    |
| Missing baselines         | Reviewer asks "why not compare to X?"     | Survey 3+ recent papers for every table                       |
| Cherry-picked results     | Select only the one metric where you win  | Report all metrics; explain losses                            |
| Undefined notation        | Reader stops at first unknown symbol      | Define everything on first use                                |
| Figure not referenced     | Figure exists but reader doesn't know why | Every figure must follow from text that refers to it          |
| Empty future work         | "More research needed"                    | Name a specific extension: "extend X to handle Y"             |
| Latex compilation errors  | Camera-ready fails                        | Run `latexmk` before submission; check for overfull hboxes    |
| Plagiarism of own writing | Self-plagiarism is still plagiarism       | Paraphrase your prior work; cite yourself                     |
| Citation padding          | Unrelated citations inflate count         | Every citation must be relevant to the sentence it appears in |

---

## 6. Venue facts change every cycle: look them up, do not remember them

Templates and limits are re-issued annually. Get them from the venue, in this
order, and record what you did in the repository:

1. `\documentclass` - take it from the venue's own starter (the CFP links a
   zip or an Overleaf template). Do not copy a class file name out of a paper
   you read.
2. Page limit - read the CFP's submission section for this cycle. Count only
   what the CFP says counts (usually body plus figures, excluding references
   and appendix; sometimes the appendix counts, and that difference sinks
   submissions).
3. Anonymity - the same CFP paragraph states it, and it differs per venue and
   per track (main, dataset-and-benchmark, workshop).
4. Camera-ready - a separate deadline and a separate limit, usually one page
   more.

Two checks an agent can run before reading anything:

```bash
ls *.sty *.cls        # what template is actually in the tree
grep -n 'documentclass' *.tex
```

If the class name's year is not the current cycle, the paper is on last cycle's
template: stop and fetch the current one.

### Anonymity checklist

Five checks that catch nearly every desk-reject:

1. Acknowledgements name nobody and thank no institution.
2. No self-citation in the first person ("our earlier work"); cite in the third person.
3. No repository, project page, or dataset link that resolves to your identity.
4. No author names or affiliations left in the PDF metadata (`pdfinfo paper.pdf`).
5. Supplementary material and appendix are anonymized too, and no grant numbers survive there.

---

## Related Skills

- `research` - literature search and fact-checking for citations
- `tone-quality` - academic tone enforcement
- `visual-creator` - figure and diagram critique when the plot is the argument
