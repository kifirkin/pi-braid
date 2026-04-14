---
name: vcs-tools
description: "Use for version control workflows with Git and Pijul. Includes checkpointing, patch-level rewind, worktree/channel management, and parallel agent workspace setup. Use when: committing, branching, rewinding, creating workspaces, parallel agent work, patch history, or surgical undo."
---

# VCS Tools: Git + Pijul

Unified version control skill covering both Git and Pijul workflows.

## Quick Reference

| Action | Git | Pijul |
|--------|-----|-------|
| Create workspace | `git worktree add <path> <branch>` | `pijul channel create <name>` |
| List workspaces | `git worktree list` | `pijul channel list` |
| Switch workspace | `cd <path>` | `pijul switch <name>` |
| Sync upstream | `git pull --rebase` | `pijul pull` |
| Remove workspace | `git worktree remove <path>` | `pijul channel delete <name>` |
| View history | `git log` | `pijul_log` tool |
| Rewind | `git revert <sha>` | `pijul_surgical_rewind` tool |

## Detection

```bash
git rev-parse --git-dir 2>/dev/null && echo "git"
ls .pijul 2>/dev/null && echo "pijul"
```

---

## Pijul Checkpointing

Pijul provides patch-level history with commutative properties, enabling surgical undo.

### Tools

- **`pijul_log`** — View patch history (limit, specific hash)
- **`pijul_surgical_rewind`** — Un-apply a specific patch (atomic undo)
- **`pijul_reset`** — Reset working directory to a specific patch

### Advantages over Git

1. **Commutative** — Patches apply in any order
2. **Lighter** — Delta-based vs full snapshots
3. **Conflict handling** — First-class support
4. **Trackable** — Agent knows its own changes

### Usage

Patches are recorded automatically at turn start. Use `pijul_log` to view history, `pijul_surgical_rewind` to revert specific patches.

---

## Git Worktrees

### Parallel Agent Workflow

```bash
# Create feature workspace
git fetch upstream
git worktree add ../agent-<task> -b agent/<task> upstream/main
cd ../agent-<task>
# ... agent works here ...
git push -u origin agent/<task>
# After merge:
git worktree remove ../agent-<task>
git branch -d agent/<task>
```

### Best Practices

- Main workspace stays clean on main/develop
- One worktree per agent/feature
- Never work in the same tree simultaneously
- Sync before branching, clean up after merging

### Cleanup

```bash
git worktree list --porcelain | grep worktree | awk '{print $2}' | xargs -I {} git worktree remove {} 2>/dev/null
git worktree prune
```

---

## Pijul Channels

Lighter than git worktrees — just a label + applied patches, same directory.

### Parallel Agent Workflow

```bash
pijul pull
pijul channel create agent-<task>
pijul switch agent-<task>
# ... agent works here ...
pijul record -m "feat: description"
pijul switch main
pijul merge agent-<task>
pijul push
pijul channel delete agent-<task>
```

### Best Practices

- Default channel (`main`/`development`) stays clean
- One channel per agent/feature
- Channels share same repo directory (no path conflicts)
- Merge when ready, delete after

### Cleanup

```bash
pijul channel list | grep -v '^\*' | grep -v '^$' | awk '{print $1}' | xargs -I {} pijul channel delete {}
```

## Git Hygiene

**Format:** `type(scope): subject` (feat, fix, docs, refactor, test, chore)
**Rules:** Subject <50 chars, imperative mood
**Before push:** Tests pass, self-review done
