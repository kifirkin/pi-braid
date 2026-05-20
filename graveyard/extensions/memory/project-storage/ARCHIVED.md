# project-storage.ts — Project Storage (Cognitive Systems)

**Origin**: Part of the old cognitive-systems extension.

**What it was supposed to do**: Provide persistent storage per git repository: stable project ID
(hash of git root), storage directory under `~/.pi/memory/projects/<project-id>/`.

**Why it was abandoned**: Never imported by any extension. The cognitive-systems extension was
renamed and refactored into memory-agent-bridge, and project-scoped storage was handled
differently by the three-memory-stores system.

**Tests**: None.