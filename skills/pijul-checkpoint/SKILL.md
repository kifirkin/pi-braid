---
name: pijul-checkpoint
description: Use Pijul for lightweight, surgical rewind of agent changes. Provides patch-level history and atomic undo.
disable-model-invocation: true
---

# Pijul Checkpoint Skill

This skill provides Pijul-based checkpointing for surgical rewinding of agent changes. Unlike Git snapshots, Pijul operates at the patch level with commutative properties.

## Installation

Requires Pijul to be installed:
```bash
cargo install pijul
```

The extension is automatically enabled when:
1. Pijul is installed
2. The project has a `.pijul` directory (initialized on first run)

## Usage

### Recording Changes

Patches are automatically recorded at the start of each turn. No manual action needed.

### Viewing Patch History

List recent patches:
```
pijul read
```

Show specific patch details:
```
pijul read patchHash: "abc123"
```

Limit output:
```
pijul read limit: 20
```

### Rewinding to Previous State

Un-apply a specific patch to revert its changes:
```
pijul unapply <patch-hash>
```

### Forking with Partial History

Create a fork with only certain patches:
```
pijul fork patchHashes: ["abc123", "def456"]
```

## Tools

- `pijul_read` - View patch history
- `pijul_unapply` - Revert a specific patch
- `pijul_fork` - Create a fork with selected patches

## Advantages over Git

1. **Commutative** - Patches can be applied in any order
2. **Lighter** - Delta-based vs full snapshots
3. **Conflict handling** - First-class support
4. **Trackable** - Agent knows its own changes

## Notes

- Each session creates its own `.pijul` repository
- Patches are recorded automatically at turn_start
- Hashes can be shortened (minimum 4 characters)
- Requires `pijul` CLI installed on system