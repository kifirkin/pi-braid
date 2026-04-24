# Skills Catalog

pi-braid ships with 12 bundled skills. Each skill has a `SKILL.md` with detailed usage instructions.

| Skill | When to Activate | Key Content |
|-------|-----------------|-------------|
| **`software-engineer`** | Any coding task | Universal coding protocol: analyze → decompose → execute → verify |
| **`research`** | Looking up info, fact-checking | Web search, DuckDuckGo HTML, fact verification, literature review |
| **`pi-reference`** | Questions about pi config/SDK | SDK docs, extensions, skills, themes, keybindings, RPC mode |
| **`healthcheck`** | Tool failures, environment issues | Self-diagnostic, process cleanup, capability testing |
| **`process-control`** | Long-running processes | tmux (interactive), nohup (fire-and-forget), parallel workers |
| **`documentation`** | Documenting a codebase | Architecture docs, README generation, doc ecosystem |
| **`code-search`** | Searching/refactoring code | ast-grep vs ripgrep selection, codemod patterns |
| **`meta-improvement`** | Creating new skills | SKILL.md anatomy, testing, archive-based evolution |
| **`agent-testing`** | Benchmarking, test suites | pi RPC mode, Python/JS harness, benchmark template |
| **`tone-quality`** | Writing human-readable text | Directive density, voice artifacts, epistemic calibration |
| **`paper-writer`** | LaTeX research papers | IMRaD structure, academic tone, LaTeX optimization |
| **`vcs-tools`** | Version control | Git/Pijul, worktrees, channels, patch-level rewind |
| **`npm-approval`** | FSTEK compliance review | Package audit, compliance summaries, approval checklists |
| **`process-control`** | Long-running tasks | tmux, nohup, parallel workers, session locations |
| **`visual-validator`** | Visual validation | Sprite assets, game screenshots, UI design critique |
| **`paper-writer`** | Research papers | LaTeX, IMRaD, academic tone |
| **`prompt-writer`** | Prompt crafting | Prompt structure, optimization techniques |
| **`tone-quality`** | Writing quality | Directive density, voice, epistemic calibration |

*Total: 13 skills. All have `skills/*/SKILL.md`.*

## Activation Patterns

| Pattern | Skills to Activate |
|---------|-------------------|
| Debugging | `software-engineer` + `process-control` |
| Research | `research` |
| Documentation | `documentation` + `tone-quality` |
| Testing | `agent-testing` |
| Self-improvement | `meta-improvement` |
| Compliance | `npm-approval` |

## Skill Directory

```
skills/
├── agent-testing/SKILL.md
├── code-search/SKILL.md
├── documentation/SKILL.md
├── healthcheck/SKILL.md
├── meta-improvement/SKILL.md
├── npm-approval/SKILL.md
├── paper-writer/SKILL.md
├── pi-reference/SKILL.md
├── process-control/SKILL.md
├── research/SKILL.md
├── software-engineer/SKILL.md
├── tone-quality/SKILL.md
└── vcs-tools/SKILL.md
```
