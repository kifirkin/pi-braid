---
name: codebase-summary
description: "Analyze a repository and generate comprehensive architecture documentation, AGENTS.md, README.md, or a full documentation ecosystem. Use when asked to 'document this codebase', 'generate AGENTS.md', 'summarize architecture', or 'create project docs'."
---

# Codebase Summary

Analyze a codebase and generate structured documentation for AI assistants and developers.

## Parameters

Gather all parameters upfront in a single prompt:

| Parameter | Default | Purpose |
|-----------|---------|---------|
| `output_dir` | `.agents/summary` | Where to store documentation |
| `consolidate` | `true` | Create consolidated files (AGENTS.md, etc.) |
| `consolidate_targets` | `AGENTS.md` | Comma-separated target files |
| `consolidate_prompt` | (auto) | How to structure consolidated content |
| `check_consistency` | `true` | Cross-check documents for conflicts |
| `check_completeness` | `true` | Identify gaps in coverage |
| `update_mode` | `false` | Update existing docs based on recent commits |
| `codebase_path` | `.` | Path to analyze |

## Process

### 1. Setup
- Validate `codebase_path` exists
- Create `output_dir` if needed
- If `update_mode`: check `{output_dir}/.last_commit` for baseline, use `git log` to find changes since

### 2. Analyze
- Map packages, modules, components
- Identify tech stack and dependencies
- Find key interfaces, APIs, integration points
- Analyze design patterns and code structure
- If `update_mode`: prioritize modified components
- Save to `{output_dir}/codebase_info.md`

### 3. Generate Documentation
Create these files in `output_dir/`:

| File | Content |
|------|---------|
| `index.md` | Knowledge base index with metadata, TOC, cross-references. Primary file for AI assistants. |
| `architecture.md` | System architecture and design patterns |
| `components.md` | Major components and responsibilities |
| `interfaces.md` | APIs, interfaces, integration points |
| `data_models.md` | Data structures and models |
| `workflows.md` | Key processes and workflows |
| `dependencies.md` | External dependencies and usage |

Use **Mermaid diagrams** for all visual representations (never ASCII art).

### 4. Review
- If `check_consistency`: cross-reference docs for conflicts
- If `check_completeness`: identify under-documented areas
- Save findings to `{output_dir}/review_notes.md`

### 5. Consolidate
If `consolidate` is true, create target files in the project root:

| Target | Focus |
|--------|-------|
| `AGENTS.md` | AI assistant context, project structure, dev patterns, test instructions |
| `README.md` | Project overview, installation, usage |
| `CONTRIBUTING.md` | Dev setup, coding standards, contribution workflow |

Merge with existing content (don't overwrite manually-curated sections).

### 6. Finalize
- Save current git HEAD to `{output_dir}/.last_commit`
- Summarize what was generated
- Recommend `index.md` as primary AI context file

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
├── review_notes.md
└── recent_changes.md (update_mode only)
```
