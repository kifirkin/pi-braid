---
name: vcs-tools
description: "Version control with Git and Pijul: checkpointing, patch-level rewind, worktree/channel management, and parallel agent workspace setup. Use when committing, branching, rewinding, creating workspaces, or managing parallel agents."
---

# VCS Tools

Git and Pijul workflows for version control, parallel work, and surgical undo.

---

## Detection

```bash
git rev-parse --git-dir 2>/dev/null && echo "git"
ls .pijul 2>/dev/null && echo "pijul"
```

---

## Quick Reference

| Action           | Git                                | Pijul                         |
| ---------------- | ---------------------------------- | ----------------------------- |
| Create workspace | `git worktree add <path> <branch>` | `pijul channel create <name>` |
| List workspaces  | `git worktree list`                | `pijul channel list`          |
| Switch workspace | `cd <path>`                        | `pijul switch <name>`         |
| Remove workspace | `git worktree remove <path>`       | `pijul channel delete <name>` |
| View history     | `git log`                          | `pijul_log` tool              |
| Surgical undo    | `git revert <sha>`                 | `pijul_surgical_rewind` tool  |

---

## Pijul Checkpointing

Pijul provides patch-level history with commutative properties — patches apply in any order, enabling surgical undo at the patch level.

### Advantages over Git

1. **Commutative** — Patches apply in any order
2. **Lighter** — Delta-based vs full snapshots
3. **Conflict handling** — First-class support
4. **Trackable** — Agent knows its own changes

### Custom Commands

These are custom shell commands that may be available in your environment:

| Command                 | Purpose                            |
| ----------------------- | ---------------------------------- |
| `pijul_log`             | View patch history                 |
| `pijul_surgical_rewind` | Un-apply a specific patch          |
| `pijul_reset`           | Reset working directory to a patch |

Patches are recorded automatically at turn start. Use `pijul_log` to view history, `pijul_surgical_rewind` to revert specific patches.

---

## Git Worktrees

Parallel agents or features, each in its own tree:

```bash
# Create
git fetch upstream
git worktree add ../agent-<task> -b agent/<task> upstream/main
cd ../agent-<task>

# After merge: cleanup
git worktree remove ../agent-<task>
git branch -d agent/<task>
```

Keep the main workspace clean on main/develop. One worktree per agent or feature. Sync before branching, clean up after merging.

---

## Pijul Channels

Lighter than git worktrees — a label + applied patches, same directory:

```bash
pijul pull
pijul channel create agent-<task>
pijul switch agent-<task>
# ... work ...
pijul record -m "feat: description"
pijul switch main
pijul merge agent-<task>
pijul push
pijul channel delete agent-<task>
```

---

## Commit Format

`type(scope): subject` — feat, fix, docs, refactor, test, chore

Subject under 50 characters, imperative mood. Before push: tests pass, self-review done.
