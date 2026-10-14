/**
 * test-check-instruction-strings.mjs — the instruction-string reference lint:
 * a tool name in an emitted string must be registered, and a quoted
 * `action="x"` must be a value of that tool's action enum. The scan is
 * AST-based, so a name in a comment is not a reference, and template-literal
 * escapes do not hide one.
 *
 * Cases:
 *   1. a registered tool, backticked and called with a valid action -> clean
 *   2. a backticked tool that is not registered -> exit 1, named with its line
 *   3. `action="x"` outside the derived enum -> exit 1
 *   4. `action="x"` on a tool that declares no action parameter -> exit 1
 *   5. a deliberate mention with `// tool-ref-exempt: reason` -> exit 0 and
 *      counted; a marker with no reason excuses nothing -> exit 1
 *   6. a mention in a comment only is not a reference (AST, not grep)
 *   7. a bare snake_case word with no registered family companion is not a
 *      reference; with a same-family registered tool in the unit it is
 *   8. a baseline row clears its finding; a row that stops matching is stale
 *      -> exit 1
 *   9. an external tool name is counted, not failed
 *  10. an escaped backtick in a template literal does not hide the reference
 *  11. withheld shapes: declarations, test trees and script trees are not
 *      scanned; a string in an unregistered package still is
 *  12. the real tree runs clean through the CLI from two working directories
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runInstructionLint } from "../../../scripts/check-instruction-strings.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "../../..");
const SCRIPT = join(ROOT, "scripts", "check-instruction-strings.mjs");

/** Build a throwaway tree from `{ relativePath: content }`, run `fn`, remove it. */
function withTree(files, fn) {
  const tree = mkdtempSync(join(tmpdir(), "instrlint-"));
  try {
    for (const [rel, content] of Object.entries(files)) {
      const full = join(tree, rel);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, content);
    }
    return fn(tree);
  } finally {
    rmSync(tree, { recursive: true, force: true });
  }
}

const TOOLS = `
const tools = [
  {
    name: "foo_bar",
    description: "control the foo",
    parameters: Type.Object({
      action: Type.Union([Type.Literal("start"), Type.Literal("stop")], { description: "Action" }),
    }),
    execute() {},
  },
  {
    name: "gizmo",
    description: "read the gizmo",
    parameters: Type.Object({ detail: Type.String({ enum: ["quick", "full"] }) }),
    execute() {},
  },
];
`;

/** Fixture runs carry no recorded rows unless the case supplies them. */
const run = (tree, baseline = []) => runInstructionLint(tree, { baseline });

test("a registered tool with a valid action is clean", () => {
  withTree(
    {
      "packages/core/src/tools.ts": TOOLS,
      "packages/core/src/strings.ts":
        'export const message = "Call `foo_bar(action=\\"start\\")` to begin.";\n',
    },
    (tree) => {
      const result = run(tree);
      assert.equal(result.exitCode, 0);
      assert.deepEqual(result.unresolved, []);
      // The reference is both backticked and call-shaped: two shapes, one
      // reference, both checked.
      assert.deepEqual(
        result.findings.map((f) => f.kind).sort(),
        ["backtick", "call"],
      );
    },
  );
});

test("an unregistered backticked tool fails with its line", () => {
  withTree(
    {
      "packages/core/src/tools.ts": TOOLS,
      "packages/core/src/strings.ts": 'export const message = "consider `foo_baz` for old work";\n',
    },
    (tree) => {
      const result = run(tree);
      assert.equal(result.exitCode, 1);
      assert.equal(result.unresolved.length, 1);
      assert.equal(result.unresolved[0].token, "foo_baz");
      assert.equal(result.unresolved[0].why, "tool-not-registered");
      assert.equal(result.unresolved[0].line, 1);
    },
  );
});

test("an action outside the derived enum fails", () => {
  withTree(
    {
      "packages/core/src/tools.ts": TOOLS,
      "packages/core/src/strings.ts":
        'export const message = "Call foo_bar(action=\\"explode\\") now.";\n',
    },
    (tree) => {
      const result = run(tree);
      assert.equal(result.exitCode, 1);
      assert.equal(result.unresolved[0].why, "action-not-in-enum");
      assert.deepEqual(result.unresolved[0].enumValues, ["start", "stop"]);
    },
  );
});

test("an action on a tool that declares no action parameter fails", () => {
  withTree(
    {
      "packages/core/src/tools.ts": TOOLS,
      "packages/core/src/strings.ts": 'export const message = "Run gizmo(action=\\"quick\\").";\n',
    },
    (tree) => {
      const result = run(tree);
      assert.equal(result.exitCode, 1);
      assert.equal(result.unresolved[0].why, "action-param-missing");
    },
  );
});

test("an inline exemption clears the finding and is counted", () => {
  withTree(
    {
      "packages/core/src/tools.ts": TOOLS,
      "packages/core/src/strings.ts":
        'export const message = "consider `foo_baz`"; // tool-ref-exempt: retired predecessor named as history\n',
    },
    (tree) => {
      const result = run(tree);
      assert.equal(result.exitCode, 0);
      assert.equal(result.exemptions.length, 1);
      assert.match(result.exemptions[0].reason, /retired predecessor/);
    },
  );
});

test("a marker with no reason excuses nothing", () => {
  withTree(
    {
      "packages/core/src/tools.ts": TOOLS,
      "packages/core/src/strings.ts":
        'export const message = "consider `foo_baz`"; // tool-ref-exempt:\n',
    },
    (tree) => {
      const result = run(tree);
      assert.equal(result.exitCode, 1);
      assert.equal(result.unresolved.length, 1);
    },
  );
});

test("a mention in a comment only is not a reference", () => {
  withTree(
    {
      "packages/core/src/tools.ts": TOOLS,
      "packages/core/src/strings.ts": "// call foo_baz() here one day\nexport const x = 1;\n",
    },
    (tree) => {
      const result = run(tree);
      assert.equal(result.exitCode, 0);
      assert.equal(result.findings.length, 0);
    },
  );
});

test("a bare same-family token is a reference only beside a registered tool", () => {
  withTree(
    {
      "packages/core/src/tools.ts": TOOLS,
      "packages/core/src/strings.ts": 'export const alone = "the job_runner looped";\n',
    },
    (tree) => {
      assert.equal(run(tree).exitCode, 0);
    },
  );
  withTree(
    {
      "packages/core/src/tools.ts": TOOLS,
      "packages/core/src/strings.ts": 'export const together = "start foo_baz then `foo_bar`";\n',
    },
    (tree) => {
      const result = run(tree);
      assert.equal(result.exitCode, 1);
      assert.equal(result.unresolved[0].token, "foo_baz");
      assert.equal(result.unresolved[0].kind, "family");
    },
  );
});

test("a baseline row clears its finding; a row that stops matching is stale", () => {
  const strings = 'export const message = "consider `foo_baz` for old work";\n';
  withTree(
    {
      "packages/core/src/tools.ts": TOOLS,
      "packages/core/src/strings.ts": strings,
    },
    (tree) => {
      const row = {
        file: "packages/core/src/strings.ts",
        token: "foo_baz",
        reason: "queued instruction repair",
      };
      assert.equal(run(tree, [row]).exitCode, 0);
      const stale = run(tree, [{ ...row, token: "vanished" }]);
      assert.equal(stale.exitCode, 1);
      assert.deepEqual(
        stale.staleRows.map((r) => r.token),
        ["vanished"],
      );
    },
  );
});

test("an external tool name is counted, not failed", () => {
  withTree(
    {
      "packages/core/src/strings.ts": 'export const message = "Use `read` first.";\n',
    },
    (tree) => {
      const result = run(tree);
      assert.equal(result.exitCode, 0);
      assert.equal(result.external.length, 1);
      assert.equal(result.external[0].token, "read");
    },
  );
});

test("an escaped backtick in a template literal does not hide a reference", () => {
  withTree(
    {
      "packages/core/src/tools.ts": TOOLS,
      "packages/core/src/strings.ts":
        "export const message = `Run \\`foo_baz\\` before continuing.`;\n",
    },
    (tree) => {
      const result = run(tree);
      assert.equal(result.exitCode, 1);
      assert.equal(result.unresolved[0].token, "foo_baz");
    },
  );
});

test("withheld shapes: declarations, test trees and script trees are not scanned", () => {
  withTree(
    {
      "packages/core/src/types.d.ts": 'export declare const message: "use `foo_baz`";\n',
      "packages/core/test/runtime/test-fixture.mjs": 'const s = "use `foo_baz`";\n',
      "packages/core/scripts/tool.mjs": 'const s = "use `foo_baz`";\n',
    },
    (tree) => {
      const result = run(tree);
      assert.equal(result.exitCode, 0);
      assert.equal(result.findings.length, 0);
    },
  );
});

test("the real tree is clean through the CLI from two working directories", () => {
  const fromRepo = spawnSync("node", [SCRIPT], { cwd: ROOT, encoding: "utf8" });
  const fromRoot = spawnSync("node", [SCRIPT], { cwd: "/", encoding: "utf8" });
  const summary = (r) => (r.stdout + r.stderr).match(/Registry: .*/)?.[0] ?? null;
  assert.equal(fromRepo.status, 0, fromRepo.stdout + fromRepo.stderr);
  assert.equal(fromRoot.status, 0, fromRoot.stdout + fromRoot.stderr);
  assert.ok(summary(fromRepo), "the registry summary line must print");
  assert.equal(summary(fromRoot), summary(fromRepo));
});
