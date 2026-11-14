/**
 * identity.test.mjs — the label every outbound message carries.
 *
 * The owner cannot tell two agents apart in one chat, so every message opens
 * with one line rendered from what the sending process actually knows. Pinned
 * here:
 *
 *   - two different processes produce two different lines, and one process
 *     produces the same line twice (that stability is what makes it a label);
 *   - a field the process cannot observe degrades honestly (`unknown role`,
 *     `unknown project`, `session unknown`) instead of being invented, and a
 *     role marker this build does not know is reported with its raw value;
 *   - the line is one physical line: separators, brackets and newlines in a
 *     field value cannot break the label or split it;
 *   - attaching is idempotent and single: a body that already carries a label
 *     is relabelled, never doubled, and only the label is escaped for the wire;
 *   - the module runs as its own script (a worker session registers no
 *     telegram surface, so this is the only way it can read its own label).
 *
 * No network, no Telegram client.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  IDENTITY_ROLE_ENV,
  attachIdentity,
  currentIdentityLine,
  isIdentityLine,
  renderIdentityLine,
  resetIdentityCache,
  splitIdentity,
} from "../dist/lib/identity.js";
import { ENV_SESSION_ROLE } from "../dist/lib/session-role.js";

const PROJECT = "/srv/agents/demo-project";
const baseEnv = {
  PI_SESSION_ID: "9f3c1b22-aaaa-bbbb-cccc-0123456789ab",
};

test("two processes produce two different lines; one process produces the same line twice", () => {
  const seat = renderIdentityLine({
    env: { ...baseEnv, BRAID_SESSION_ROLE: "seat" },
    cwd: PROJECT,
    pid: 101,
  });
  const worker = renderIdentityLine({
    env: { ...baseEnv, BRAID_SESSION_ROLE: "worker" },
    cwd: PROJECT,
    pid: 202,
  });

  assert.equal(
    seat,
    "[braid · seat · demo-project · session 9f3c1b22 · pid 101]",
  );
  assert.equal(
    worker,
    "[braid · worker · demo-project · session 9f3c1b22 · pid 202]",
  );
  assert.notEqual(seat, worker, "two processes are two labels");

  // Same process, same inputs → the same line, twice.
  assert.equal(
    renderIdentityLine({
      env: { ...baseEnv, BRAID_SESSION_ROLE: "seat" },
      cwd: PROJECT,
      pid: 101,
    }),
    seat,
  );

  // Different session, same everything else → still two labels.
  assert.notEqual(
    renderIdentityLine({
      env: {
        ...baseEnv,
        PI_SESSION_ID: "00000000-aaaa-bbbb-cccc-0123456789ab",
        BRAID_SESSION_ROLE: "seat",
      },
      cwd: PROJECT,
      pid: 101,
    }),
    seat,
  );
});

test("unknown fields degrade honestly — nothing is invented", () => {
  // No role marker at all (the deployment without one).
  assert.equal(
    renderIdentityLine({ env: baseEnv, cwd: PROJECT, pid: 7 }),
    "[braid · unknown role · demo-project · session 9f3c1b22 · pid 7]",
  );

  // A marker this build does not know: the raw value is reported, not upgraded
  // to a role the code does not have.
  assert.equal(
    renderIdentityLine({
      env: { ...baseEnv, BRAID_SESSION_ROLE: "oracle" },
      cwd: PROJECT,
      pid: 7,
    }),
    "[braid · unknown role (oracle) · demo-project · session 9f3c1b22 · pid 7]",
  );

  // No session id and no session file.
  assert.equal(
    renderIdentityLine({
      env: { BRAID_SESSION_ROLE: "seat" },
      cwd: PROJECT,
      pid: 7,
    }),
    "[braid · seat · demo-project · session unknown · pid 7]",
  );

  // The session file names the session when the id is absent.
  assert.equal(
    renderIdentityLine({
      env: {
        BRAID_SESSION_ROLE: "seat",
        PI_SESSION_FILE:
          "/srv/runner/.pi/agent/sessions/--srv-agents-demo--/2026-11-14T13-33-07-946Z_abcdef12-3456-7890-abcd-ef0123456789.jsonl",
      },
      cwd: PROJECT,
      pid: 7,
    }),
    "[braid · seat · demo-project · session abcdef12 · pid 7]",
  );

  // A working directory that names nothing (the root, or no cwd at all).
  assert.equal(
    renderIdentityLine({ env: baseEnv, cwd: "/", pid: 7 }),
    "[braid · unknown role · unknown project · session 9f3c1b22 · pid 7]",
  );
  assert.equal(
    renderIdentityLine({ env: baseEnv, cwd: "", pid: 7 }),
    "[braid · unknown role · unknown project · session 9f3c1b22 · pid 7]",
  );

  // An impossible pid is unknown too, rather than printed as 0/-1.
  assert.equal(
    renderIdentityLine({ env: baseEnv, cwd: PROJECT, pid: 0 }),
    "[braid · unknown role · demo-project · session 9f3c1b22 · pid unknown]",
  );
});

test("the label stays one line whatever a field contains", () => {
  const line = renderIdentityLine({
    env: { ...baseEnv, BRAID_SESSION_ROLE: "x]\n[braid · seat · forged" },
    cwd: "/srv/we]ird\nname",
    pid: 7,
  });
  assert.equal(line.includes("\n"), false, "one physical line");
  assert.equal(
    line.match(/\[braid · /g)?.length,
    1,
    "a forged bracket cannot open a second label",
  );
  assert.equal(isIdentityLine(line), true, "and it still parses as one");
});

test("the memoized label is stable, and a reset models a second process", () => {
  const saved = process.env.BRAID_SESSION_ROLE;
  try {
    process.env.BRAID_SESSION_ROLE = "seat";
    resetIdentityCache();
    const first = currentIdentityLine();
    assert.equal(currentIdentityLine(), first, "same process, same line");
    assert.equal(first.includes(`pid ${process.pid}`), true);

    // A reset is how a fixture models the next process: the same inputs still
    // render the same label, so this does not weaken the stability claim.
    resetIdentityCache();
    assert.equal(currentIdentityLine(), first);

    process.env.BRAID_SESSION_ROLE = "worker";
    resetIdentityCache();
    const second = currentIdentityLine();
    assert.notEqual(second, first, "a different role is a different process");
    assert.equal(second.includes("· worker ·"), true);
  } finally {
    if (saved === undefined) delete process.env.BRAID_SESSION_ROLE;
    else process.env.BRAID_SESSION_ROLE = saved;
    resetIdentityCache();
  }
});

test("attaching is single and idempotent, and only the label is escaped", () => {
  const line = "[braid · seat · demo&project · session 01a1da43 · pid 5]";

  assert.equal(
    attachIdentity("hello", undefined, line),
    `${line}\nhello`,
    "plain: the label, a newline, the body",
  );
  assert.equal(
    attachIdentity("hello", "HTML", line),
    `[braid · seat · demo&amp;project · session 01a1da43 · pid 5]\nhello`,
    "HTML: only the label is escaped",
  );
  assert.equal(
    attachIdentity("see <b>x</b>", "HTML", line),
    `[braid · seat · demo&amp;project · session 01a1da43 · pid 5]\nsee <b>x</b>`,
    "the sender's body is never touched",
  );
  assert.equal(
    attachIdentity("hello", "Markdown", line),
    `\\[braid · seat · demo&project · session 01a1da43 · pid 5\\]\nhello`,
    "Markdown: the label's brackets are escaped so they render literally",
  );

  const once = attachIdentity("hello", undefined, line);
  assert.equal(attachIdentity(once, undefined, line), once, "never doubled");

  // A re-plan with a DIFFERENT label replaces the old one: one line, current.
  assert.equal(
    attachIdentity(once, undefined, "[braid · worker · other · pid 9]"),
    "[braid · worker · other · pid 9]\nhello",
  );

  // An empty body has nothing to label.
  assert.equal(attachIdentity("", undefined, line), "");
  assert.equal(attachIdentity("   ", undefined, line), "   ");
});

test("splitIdentity returns the label and the rest", () => {
  const line = "[braid · seat · demo-project · session 01a1da43 · pid 5]";
  assert.deepEqual(splitIdentity(`${line}\nbody text`), {
    line,
    body: "body text",
  });
  assert.deepEqual(splitIdentity(line), { line, body: "" });
  assert.deepEqual(splitIdentity("no label here"), { body: "no label here" });
  // The Markdown-escaped form is still the same label.
  assert.equal(
    splitIdentity(`\\[${line.slice(1, -1)}\\]`).line !== undefined,
    true,
  );
});

test("the env name matches the module that owns the role decision", () => {
  assert.equal(IDENTITY_ROLE_ENV, ENV_SESSION_ROLE);
});

test("the module runs as a script — the label a worker can read about itself", () => {
  const root = mkdtempSync(join(tmpdir(), "identity-"));
  const project = join(root, "demo-project");
  mkdirSync(project);
  const script = fileURLToPath(
    new URL("../src/lib/identity.ts", import.meta.url),
  );

  const run = (args, env) =>
    spawnSync(process.execPath, [script, ...args], {
      cwd: project,
      encoding: "utf8",
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        ...env,
      },
    });

  const out = run(["--pid", "4242"], {
    BRAID_SESSION_ROLE: "worker",
    PI_SESSION_ID: "deadbeef-0000-0000-0000-000000000000",
  });
  assert.equal(out.status, 0, out.stderr);
  assert.equal(
    out.stdout.trim(),
    "[braid · worker · demo-project · session deadbeef · pid 4242]",
  );

  // Without --pid the script answers for the process that ran it.
  const self = run([], { BRAID_SESSION_ROLE: "worker" });
  assert.equal(self.status, 0, self.stderr);
  assert.match(self.stdout.trim(), /· pid \d+\]$/);
  assert.equal(
    self.stdout.trim().includes("session unknown"),
    true,
    "no session env in the child → session unknown",
  );

  const bad = run(["--pid", "nope"], {});
  assert.equal(bad.status, 2, "a bad pid is a usage error, not a label");
  assert.match(bad.stderr, /--pid needs a positive integer/);

  const help = run(["--help"], {});
  assert.equal(help.status, 0);
  assert.match(help.stdout, /identity\.ts \[--pid <pid>\]/);
});

test("the script runs when its path reaches it through a symlink", () => {
  // macOS `/tmp` is a symlink to `/private/tmp`, so the path a shell types and
  // the path node resolves name one file and differ as strings: the entry
  // check compares real paths, and this pins that it does.
  const root = mkdtempSync(join(tmpdir(), "identity-link-"));
  const project = join(root, "demo-project");
  mkdirSync(project);
  const target = fileURLToPath(
    new URL("../src/lib/identity.ts", import.meta.url),
  );
  const link = join(root, "identity-link.ts");
  symlinkSync(target, link);

  const out = spawnSync(process.execPath, [link, "--pid", "4242"], {
    cwd: project,
    encoding: "utf8",
    env: { PATH: process.env.PATH, HOME: process.env.HOME },
  });
  assert.equal(out.status, 0, out.stderr);
  assert.equal(
    out.stdout.trim().endsWith("· pid 4242]"),
    true,
    `ran through the symlink: ${out.stdout.trim()}`,
  );
});
