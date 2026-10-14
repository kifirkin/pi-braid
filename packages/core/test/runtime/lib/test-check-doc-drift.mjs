/**
 * test-check-doc-drift.mjs — the derived doc-reference half of the drift
 * check: an identifier-shaped name in a tracked doc must resolve to something
 * in the repo, unless the doc annotates the line as a deliberate mention, the
 * name is a recorded external surface, or the reference is a known queued fix.
 *
 * Cases:
 *   1. a current doc naming a symbol that exists in source -> clean
 *   2. the same doc naming a ghost symbol -> exit 1, named with its line
 *   3. a line-level `<!-- doc-ref-exempt: reason -->` clears it -> exit 0,
 *      counted as excused (the hatch is visible, not silent)
 *   4. an annotation with no reason excuses nothing -> exit 1
 *   5. a ghost in a `historical` / `forward-looking` doc -> advisory, exit 0
 *   6. a recorded external name -> exit 0, counted; a name no doc references
 *      is stale -> exit 1 (the inventory cannot rot)
 *   7. a known row clears its finding and is counted; a row that stops
 *      matching is stale -> exit 1 (the repair commit must delete the row)
 *   8. an annotation on another line does not clear the finding
 *   9. the scan reads the tree it is handed, never the cwd (spawned end to
 *      end from two working directories)
 *  10. withheld shapes: a plain lowercase word, a flag and a path are not
 *      references; a name that exists only inside a tracked doc's own text
 *      does not resolve against that other doc
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { checkDocReferences } from "../../../scripts/check-doc-drift.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "../../..");
const SCRIPT = join(ROOT, "scripts", "check-doc-drift.mjs");

/** Build a throwaway tree from `{ relativePath: content }`, run `fn`, remove it. */
function withTree(files, fn) {
  const tree = mkdtempSync(join(tmpdir(), "docref-"));
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

/** Fixture runs start with empty recorded sets; a case that needs a row supplies it. */
const run = (tree, options = {}) =>
  checkDocReferences({ repoRoot: tree, external: [], known: [], ...options });

test("a name that exists in source resolves", () => {
  withTree(
    {
      "packages/core/src/thing.ts": "export function liveWidget() {}\n",
      "packages/core/docs/GUIDE.md": "# Guide\n\nCall `liveWidget` to start.\n",
    },
    (tree) => {
      const result = run(tree);
      assert.equal(result.exitCode, 0);
      assert.deepEqual(result.unresolved, []);
    },
  );
});

test("a ghost name fails and is reported with its line", () => {
  withTree(
    {
      "packages/core/src/thing.ts": "export function liveWidget() {}\n",
      "packages/core/docs/GUIDE.md": "# Guide\n\nCall `ghostWidget` to start.\n",
    },
    (tree) => {
      const result = run(tree);
      assert.equal(result.exitCode, 1);
      assert.equal(result.unresolved.length, 1);
      assert.equal(result.unresolved[0].token, "ghostWidget");
      assert.equal(result.unresolved[0].doc, "packages/core/docs/GUIDE.md");
      assert.equal(result.unresolved[0].line, 3);
    },
  );
});

test("a line annotation clears the finding and is counted", () => {
  withTree(
    {
      "packages/core/docs/GUIDE.md":
        "# Guide\n\nCall `ghostWidget` to start. <!-- doc-ref-exempt: retired helper, named as history -->\n",
    },
    (tree) => {
      const result = run(tree);
      assert.equal(result.exitCode, 0);
      assert.equal(result.excused.length, 1);
      assert.equal(result.excused[0].token, "ghostWidget");
      assert.match(result.excused[0].reason, /retired helper/);
    },
  );
});

test("an annotation with no reason excuses nothing", () => {
  withTree(
    {
      "packages/core/docs/GUIDE.md": "# Guide\n\nCall `ghostWidget` to start. <!-- doc-ref-exempt: -->\n",
    },
    (tree) => {
      const result = run(tree);
      assert.equal(result.exitCode, 1);
      assert.equal(result.unresolved.length, 1);
      assert.equal(result.unresolved[0].why, "empty-annotation");
    },
  );
});

test("a ghost in a non-current doc is advisory", () => {
  withTree(
    {
      "packages/core/docs/PLAN.md":
        "<!-- status: forward-looking -->\n# Plan\n\nWe will call `futureWidget`.\n",
    },
    (tree) => {
      const result = run(tree);
      assert.equal(result.exitCode, 0);
      assert.equal(result.advisory.length, 1);
      assert.equal(result.advisory[0].token, "futureWidget");
    },
  );
});

test("an external name is counted, and an unreferenced one is stale", () => {
  withTree(
    {
      "packages/core/docs/GUIDE.md": "# Guide\n\nCall `web_search` for facts.\n",
    },
    (tree) => {
      const external = [{ name: "web_search", reason: "tool provided by a package" }];
      const result = run(tree, { external });
      assert.equal(result.exitCode, 0);
      assert.equal(result.externalRefs.length, 1);

      const stale = run(tree, { external: [...external, { name: "never_named", reason: "gone" }] });
      assert.equal(stale.exitCode, 1);
      assert.deepEqual(
        stale.staleExternal.map((row) => row.name),
        ["never_named"],
      );
    },
  );
});

test("a known row clears its finding; a row that stops matching is stale", () => {
  withTree(
    {
      "packages/core/docs/GUIDE.md": "# Guide\n\nCall `ghostWidget` to start.\n",
    },
    (tree) => {
      const known = [
        { doc: "packages/core/docs/GUIDE.md", token: "ghostWidget", reason: "queued repair" },
      ];
      const result = run(tree, { known });
      assert.equal(result.exitCode, 0);
      assert.equal(result.knownRefs.length, 1);

      const stale = run(tree, {
        known: [...known, { doc: "packages/core/docs/GUIDE.md", token: "vanished", reason: "queued repair" }],
      });
      assert.equal(stale.exitCode, 1);
      assert.deepEqual(
        stale.staleKnown.map((row) => row.token),
        ["vanished"],
      );
    },
  );
});

test("an annotation on another line does not clear the finding", () => {
  withTree(
    {
      "packages/core/docs/GUIDE.md":
        "# Guide\n\nA note. <!-- doc-ref-exempt: unrelated -->\n\nCall `ghostWidget`.\n",
    },
    (tree) => {
      const result = run(tree);
      assert.equal(result.exitCode, 1);
      assert.equal(result.unresolved.length, 1);
    },
  );
});

test("the scan is rooted at the tree it is handed, not the cwd", () => {
  // The real tree is clean, so both runs must agree on exit 0 and the same
  // summary. A cwd-relative reader would fail or scan the wrong tree.
  const fromRepo = spawnSync("node", [SCRIPT], { cwd: ROOT, encoding: "utf8" });
  const fromRoot = spawnSync("node", [SCRIPT], { cwd: "/", encoding: "utf8" });
  const summary = (r) => (r.stdout + r.stderr).match(/Derived doc references: .*/)?.[0] ?? null;
  assert.equal(fromRepo.status, 0, fromRepo.stdout + fromRepo.stderr);
  assert.equal(fromRoot.status, 0, fromRoot.stdout + fromRoot.stderr);
  assert.ok(summary(fromRepo), "the summary line must print");
  assert.equal(summary(fromRoot), summary(fromRepo));
});

test("withheld shapes are not references", () => {
  withTree(
    {
      // Plain lowercase prose, a flag and a path are not code symbols.
      "packages/core/docs/PROSE.md":
        "# Prose\n\nRun with --strict, see docs/GUIDE.md, and simply rebuild.\n" +
        // A name that appears only inside this other doc's text does not
        // resolve the first doc's claim: docs are subjects, not haystacks.
        "The `buriedName` appears only here.\n",
      "packages/core/docs/OTHER.md": "# Other\n\nMention `buriedName` only.\n",
    },
    (tree) => {
      const result = run(tree);
      // `buriedName` is unresolved in both docs; the prose shapes are not
      // candidates at all.
      assert.equal(result.considered, 2);
      assert.equal(result.unresolved.length, 2);
      assert.deepEqual(
        result.unresolved.map((f) => f.token),
        ["buriedName", "buriedName"],
      );
    },
  );
});
