---
name: subagent-verification
description: "Verify changes by spawning an isolated subagent before merging. Use when: modifying braid core or contrib, running tests after edits, validating that an integration doesn't break existing functionality. Covers: spawn-and-verify workflow, test-gate integration, failure diagnosis, and merge gates."
trigger: "before merging changes to pi-braid core or contrib, after any edit that modifies test-covered code, when verifying integration of pi-braid-lib into dependent packages"
---

# Subagent Verification

Before merging braid changes, spawn an isolated subagent to run tests and verify the build. The subagent operates in a clean context — no contamination from your editing session.

## Principle

An agent that modifies code is NEVER the agent that verifies it.

Isolation prevents:
- **Confirmation bias**: the editing agent remembers what it intended and reads tests in light of that intent
- **Context pollution**: leftover state from the edit session influences the verification pass
- **Hidden assumptions**: the editing agent knows which tests "should" pass; the verifier only knows what passes

## Workflow

```
1. Make changes in your session
2. Commit (or stash) locally so the verifier has a clean starting point
3. Spawn a subagent at the same CWD
4. Subagent runs: typecheck → build → test
5. Subagent reports results
6. If all pass: merge. If any fail: fix and repeat from step 1.
```

## Quick Spawn

```bash
# From the braid project root
python3 skills/subagent/subagent-rpc.py \
  "Run the full CI check: typecheck, build, and test. Report each step's result.
   CWD: $(pwd)
   Commands:
   1. npx tsc --noEmit
   2. npm run build
   3. npm test
   If any step fails, report the failure and exit."
```

## Verification Script

For a repeatable verification gate, create a project-level script `scripts/verify-local.mjs`:

```js
#!/usr/bin/env node
/**
 * Local verification gate: runs the same checks as CI but against local
 * changes. Exit code 0 = all gates pass.
 */
import { spawnSync } from "node:child_process";

const gates = [
  { name: "Type check", cmd: "npx", args: ["tsc", "--noEmit"] },
  { name: "Check docs", cmd: "node", args: ["scripts/check-doc-status.mjs"] },
  { name: "Check deps", cmd: "node", args: ["scripts/check-deps.mjs"] },
  { name: "Build", cmd: "npm", args: ["run", "build"] },
  { name: "Test", cmd: "npm", args: ["test"] },
];

let passed = 0;
let failed = 0;

for (const gate of gates) {
  process.stdout.write(`${gate.name}... `);
  const result = spawnSync(gate.cmd, gate.args, {
    cwd: process.cwd(),
    timeout: 120_000,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status === 0) {
    console.log("PASS");
    passed++;
  } else {
    console.log("FAIL");
    console.log(result.stdout.slice(0, 500));
    console.error(result.stderr.slice(0, 500));
    failed++;
  }
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
```

## CI Integration

The verification gate mirrors the CI pipeline defined in `.github/workflows/ci.yml`.
Run the verify script locally before pushing:

```bash
node scripts/verify-local.mjs
# If all pass: git push
# If any fail: fix and re-run
```

## Failure Diagnosis

When a gate fails in the subagent:

| Symptom | Likely Cause | Fix |
|---------|-------------|-----|
| Type error in a file you didn't edit | Pre-existing issue; verify it's not your change | `git stash` and re-run to compare |
| Test fails in subagent but passes locally | Context pollution in your session | `git stash` and run `npm test` from clean state |
| Build fails after your edit | Missing dependency or broken import | Check the error message for the exact file |
| `pi-braid-lib` not found | `npm install --ignore-scripts` was used | Run `npm install` (without `--ignore-scripts`) or `npm install pi-braid-lib` |

## Merge Gate

Only merge when ALL gates pass in the subagent:

```
PASS Type check
PASS Check docs
PASS Check deps
PASS Build
PASS Test
```

If any gate fails, do NOT merge. Fix the issue, re-verify, then merge.