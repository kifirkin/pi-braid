---
name: codebase-summary
description: "Analyze a repository and generate architecture documentation, AGENTS.md, README.md, or a full documentation ecosystem. Use when documenting a codebase, generating AGENTS.md, summarizing architecture, or creating project docs."
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

| File | Content |
|------|---------|
| `index.md` | Knowledge base index with metadata and TOC. Primary file for AI assistants. |
| `architecture.md` | System architecture and design patterns |
| `components.md` | Major components and responsibilities |
| `interfaces.md` | APIs, interfaces, integration points |
| `data_models.md` | Data structures and models |
| `workflows.md` | Key processes and workflows |
| `dependencies.md` | External dependencies and usage |

Use **Mermaid diagrams** for visual representations (never ASCII art).

### 4. Review
- Cross-reference docs for conflicts
- Identify under-documented areas
- Save findings to `{output_dir}/review_notes.md`

### 5. Consolidate
Merge with existing content (don't overwrite manually-curated sections):

| Target | Focus |
|--------|-------|
| `AGENTS.md` | AI assistant context, project structure, dev patterns, test instructions |
| `README.md` | Project overview, installation, usage |
| `CONTRIBUTING.md` | Dev setup, coding standards, contribution workflow |

### 6. Finalize
- Save git HEAD to `{output_dir}/.last_commit`
- Point to `index.md` as primary AI context file

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
