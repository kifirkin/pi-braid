---
description: Provides unified workspace management for both Git and Pijul, enabling parallel agent work without conflicts.
---

# Workspace Manager Skill

Provides unified workspace management for both Git and Pijul, enabling parallel agent work without conflicts.

## Quick Reference

| Action | Git | Pijul |
|--------|-----|-------|
| Create workspace | `git worktree add <path> <branch>` | `pijul channel create <name>` |
| List workspaces | `git worktree list` | `pijul channel list` |
| Switch workspace | `cd <path>` | `pijul switch <name>` |
| Sync with upstream | `git pull --rebase` | `pijul pull` |
| Remove workspace | `git worktree remove <path>` | `pijul channel delete <name>` |

## Git Worktrees

### Create a new worktree
```bash
git worktree add ../workspace-<name> -b feature/<name>
cd ../workspace-<name>
```

### List all worktrees
```bash
git worktree list
# Output format:
# /path/main                  123abc main
# /path/workspace-feature1    456def feature/feature1
# /path/workspace-feature2    789012 feature/feature2
```

### Remove a worktree
```bash
git worktree remove ../workspace-<name>
# Force remove if unmerged:
git worktree remove --force ../workspace-<name>
```

### Prune stale worktrees
```bash
git worktree prune
```

### Sync worktree with upstream
```bash
git fetch upstream
git rebase upstream/main  # or upstream/develop
```

### Best Practices for Parallel Agents

1. **Main workspace**: Keep clean on main/develop branch
2. **Feature worktrees**: One worktree per agent/feature
3. **Never work in same tree**: Each agent gets its own worktree
4. **Sync before branching**: Pull latest upstream before creating worktree
5. **Clean up when done**: Remove worktrees after merging

```bash
# Workflow for new agent workspace
git fetch upstream
git worktree add ../agent-<task-name> -b agent/<task-name> upstream/main
cd ../agent-<task-name>
# Agent does work here...
git push -u origin agent/<task-name>
# After merge, cleanup:
git worktree remove ../agent-<task-name>
git branch -d agent/<task-name>
```

## Pijul Channels

Pijul channels are lighter weight than git worktrees — they're just a label + patches applied.

### Create a new channel
```bash
pijul channel create <name>
```

### List channels
```bash
pijul channel list
# Output shows current channel marked with *
```

### Switch to channel
```bash
pijul switch <name>
```

### Delete a channel
```bash
pijul channel delete <name>
```

### Sync channel with remote
```bash
pijul pull
```

### Push channel to remote
```bash
pijul push
```

### Best Practices for Parallel Agents

1. **Default channel**: `main` or `development` stays clean
2. **Agent channels**: One channel per agent/feature
3. **No path conflicts**: Channels share same repo directory
4. **Merge when ready**: Use `pijul merge` to integrate channels

```bash
# Workflow for new agent channel
pijul pull
pijul channel create agent-<task-name>
pijul switch agent-<task-name>
# Agent does work here...
pijul record -m "feat: description"
# After work is done, merge back:
pijul switch main
pijul merge agent-<task-name>
pijul push
# Cleanup:
pijul channel delete agent-<task-name>
```

## Detection

Check which VCS is in use:
```bash
# Git
git rev-parse --git-dir 2>/dev/null && echo "git"

# Pijul  
ls .pijul 2>/dev/null && echo "pijul"
```

## Cleanup Commands

### Git: Find and remove stale worktrees
```bash
git worktree list --porcelain | grep worktree | awk '{print $2}' | xargs -I {} git worktree remove {} 2>/dev/null
```

### Pijul: List non-default channels for cleanup
```bash
pijul channel list | grep -v '^\*' | grep -v '^$' | awk '{print $1}' | xargs -I {} pijul channel delete {}
```

## Notes

- Git worktrees require separate directories on filesystem
- Pijul channels share the same directory (more efficient)
- Both systems track workspace metadata (worktrees in `.git/worktrees`, channels in `.pijulconfig`)
- Always sync with upstream before creating new workspace to minimize conflicts
