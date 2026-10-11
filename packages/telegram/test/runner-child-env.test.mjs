/**
 * runner-child-env.test.mjs — pins the environment normalization the test
 * runner applies to every spawned child: role-relevant ambient variables
 * (the session-role marker, the poll opt-in/out knobs, and their TELEGRAM_*
 * aliases) never reach a child, and the poller lock is redirected to a
 * per-file tmp path so the suite never races the live seat's machine-wide
 * lock.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { STRIPPED_ENV_KEYS, childEnv } from "./child-env.mjs";

const AMBIENT = {
  BRAID_SESSION_ROLE: "worker",
  BRAID_TG_POLL_ENABLED: "1",
  BRAID_TG_POLL_DISABLED: "1",
  TELEGRAM_POLL_ENABLED: "1",
  TELEGRAM_POLL_DISABLED: "1",
  TELEGRAM_POLLER_LOCK_FILE: "/tmp/ambient-alias-lock",
  BRAID_TG_POLLER_LOCK_FILE: "/tmp/ambient-canonical-lock",
  PI_TEST_TIMEOUT_MS: "90000",
  CHILD_ENV_PROBE_KEEP: "yes",
};

test("childEnv: role-relevant ambient variables never reach the child", () => {
  const env = childEnv("probe.test.mjs", AMBIENT);
  for (const key of STRIPPED_ENV_KEYS) {
    assert.equal(env[key], undefined, `${key} must be stripped`);
  }
});

test("childEnv: unrelated ambient variables pass through, marker set", () => {
  const env = childEnv("probe.test.mjs", AMBIENT);
  assert.equal(env.PI_TEST_TIMEOUT_MS, "90000");
  assert.equal(env.CHILD_ENV_PROBE_KEEP, "yes");
  assert.equal(env.PI_BRAID_TELEGRAM_TEST, "1");
});

test("childEnv: the poller lock is pinned per file over any ambient value", () => {
  const a = childEnv("a.test.mjs", AMBIENT);
  const b = childEnv("b.test.mjs", AMBIENT);
  for (const env of [a, b]) {
    assert.equal(
      env.BRAID_TG_POLLER_LOCK_FILE.startsWith(
        join(tmpdir(), "tg-poller-lock-"),
      ),
      true,
      "the pinned lock must live under the tmpdir per-file prefix",
    );
  }
  assert.notEqual(
    a.BRAID_TG_POLLER_LOCK_FILE,
    b.BRAID_TG_POLLER_LOCK_FILE,
    "each child gets its own lock path",
  );
});
