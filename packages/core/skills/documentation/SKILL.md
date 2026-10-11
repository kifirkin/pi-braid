---
name: documentation
description: "Analyze a repository and generate architecture documentation, README.md, or a full documentation ecosystem. Use when documenting a codebase, summarizing architecture, or creating project docs."
validated: 2026-08-16
verdict: IMPROVE
---

# Codebase Summary

Analyze a codebase and generate structured documentation for AI assistants and developers.

---

## Process

### 1. Setup

- Validate `codebase_path` exists
- Create `output_dir` (default: `.agents/summary`) if needed
- If `update_mode`: check `{output_dir}/.last_commit` for baseline, use `git log` for changes since

### 2. Analyze

- Map packages, modules, components
- Identify tech stack and dependencies
- Find key interfaces, APIs, integration points
- Analyze design patterns and code structure
- If `update_mode`: prioritize modified components
- Save to `{output_dir}/codebase_info.md`

### 3. Generate Documentation

Create these files in `output_dir/`:

| File              | Content                                                                     |
| ----------------- | --------------------------------------------------------------------------- |
| `index.md`        | Knowledge base index with metadata and TOC. Primary file for AI assistants. |
| `architecture.md` | System architecture and design patterns                                     |
| `components.md`   | Major components and responsibilities                                       |
| `interfaces.md`   | APIs, interfaces, integration points                                        |
| `data_models.md`  | Data structures and models                                                  |
| `workflows.md`    | Key processes and workflows                                                 |
| `dependencies.md` | External dependencies and usage                                             |

Write all documentation in clear, direct prose. Avoid filler signposting, inflated language, and uncalibrated certainty. Prefer specific statements to vague intensifiers.

Use **Mermaid diagrams** for visual representations (never ASCII art).

### 4. Review

- Cross-reference docs for conflicts
- Identify under-documented areas
- Save findings to `{output_dir}/review_notes.md`

### 5. Consolidate

Merge with existing content (don't overwrite manually-curated sections):

| Target            | Location     | Focus                                                                    |
| ----------------- | ------------ | ------------------------------------------------------------------------ |
| `AGENTS.md`       | Project root | AI assistant context, project structure, dev patterns, test instructions |
| `README.md`       | Project root | Project overview, installation, usage                                    |
| `CONTRIBUTING.md` | Project root | Dev setup, coding standards, contribution workflow                       |

The summary files in `.agents/summary/` feed into these root-level files. `index.md` remains the primary AI context file for ongoing sessions.

### 6. Finalize

- Save git HEAD to `{output_dir}/.last_commit`
- `index.md` → primary AI context file (referenced in prompt or loaded at session start)
- `AGENTS.md` → updated at project root with consolidated AI context

---

## Output Structure

```
.agents/summary/
├── .last_commit
├── index.md
├── codebase_info.md
├── architecture.md
├── components.md
├── interfaces.md
├── data_models.md
├── workflows.md
├── dependencies.md
└── review_notes.md
```
