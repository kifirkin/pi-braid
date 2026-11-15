/**
 * test-telegram-senders-census.mjs — an absent root is not evidence about a row.
 *
 * The census sweeps three roots: this repository, the installed skills tree and
 * the orchestrator's scripts. The last two live under the operator's home, so a
 * CI runner has neither. The stale-row rule used to read "I did not see this
 * file" as "this file stopped reaching the Bot API", which made every runner
 * fail the gate and blocked the 0.44.1 release: two rows were correct on the
 * machine that wrote them and stale on the machine that checked them.
 *
 * Presence is now decided per root, once. This file holds that contract from
 * both sides: an absent root leaves its rows unchecked, and a root that IS
 * present with a listed file that reaches nothing still fails. The second half
 * is the control — without it the repair could pass by never reporting a stale
 * row at all.
 *
 * Every arm spawns the shipped script with a synthetic HOME, because the roots
 * are resolved from `os.homedir()` at load and the repository root is the only
 * root present on a runner.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
// This file sits in packages/core/test/runtime/release/.
const CORE = join(HERE, "../../..");
const ROOT = join(CORE, "..", "..");
const CENSUS = join(ROOT, "scripts", "check-telegram-senders.mjs");

/** The two rows whose roots are the operator's home directories. */
const PAPER_ROW = "~/.pi/agent/skills/morning-newspaper/scripts/daily-edition.sh";
const PROBE_ROW = "~/.pi/agent/braid/orchestrator/scripts/net-probe.sh";

/** Run the census with `home` standing in for the operator's home directory. */
function census(home) {
  const result = spawnSync(process.execPath, [CENSUS], {
    encoding: "utf8",
    env: { ...process.env, HOME: home },
  });
  return { status: result.status, out: `${result.stdout}${result.stderr}` };
}

function scratch() {
  return mkdtempSync(join(tmpdir(), "census-roots-"));
}

test("an absent home root leaves its rows unchecked, not stale", () => {
  const home = scratch();
  try {
    const { status, out } = census(home);
    assert.equal(status, 0, `expected a clean run on a home-less machine:\n${out}`);
    assert.match(out, /absent on this machine, its rows are not checked/);
    assert.match(out, /not checked here: 2 rows/);
    assert.ok(out.includes(PAPER_ROW), "the paper row is named as unchecked");
    assert.ok(out.includes(PROBE_ROW), "the probe row is named as unchecked");
    assert.doesNotMatch(out, /STALE ROW/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("a present root with a listed file that reaches nothing is still stale", () => {
  const home = scratch();
  try {
    const silent = join(
      home,
      ".pi/agent/skills/morning-newspaper/scripts/daily-edition.sh",
    );
    mkdirSync(dirname(silent), { recursive: true });
    writeFileSync(silent, "#!/bin/sh\necho the paper is not sent here\n");

    const { status, out } = census(home);
    assert.equal(status, 1, `a swept root must keep the stale rule:\n${out}`);
    assert.match(out, /STALE ROW/);
    assert.ok(out.includes(PAPER_ROW), "the silent row is named");
    assert.match(out, /not checked here: 1 row/, "the absent root stays unchecked");
    assert.ok(out.includes(PROBE_ROW));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("a planted sender in a swept root is an unlisted sender", () => {
  const home = scratch();
  try {
    const planted = join(home, ".pi/agent/skills/planted/send.sh");
    mkdirSync(dirname(planted), { recursive: true });
    writeFileSync(
      planted,
      "#!/bin/sh\ncurl -X POST \"https://api.telegram.org/bot$TOKEN/sendMessage\" -d text=hi\n",
    );

    const { status, out } = census(home);
    assert.equal(status, 1, `an unlisted sender must fail the run:\n${out}`);
    assert.match(out, /UNLISTED SENDER/);
    assert.match(out, /planted\/send\.sh/, "the planted file is named");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("the shipped tree passes with every root present", () => {
  const result = spawnSync(process.execPath, [CENSUS], { encoding: "utf8" });
  const out = `${result.stdout}${result.stderr}`;
  assert.equal(result.status, 0, `the real census must pass:\n${out}`);
  assert.match(out, /0 findings/);
  assert.doesNotMatch(out, /not checked here/);
});
