/**
 * The environment every spawned test child receives.
 *
 * The poller-ownership surfaces are seat-only by design: the extension
 * factory resolves the session role from the ambient env, so a session
 * that legitimately carries the worker marker would refuse every poller
 * start inside its own suite. Each child therefore gets a neutral env:
 *
 * - BRAID_SESSION_ROLE is stripped. The seat default is the unset default;
 *   poller-guard.test.mjs sets the worker role itself where it tests that
 *   path. Pinning "seat" here would fabricate a value the tests do not
 *   set and would mask any future role value.
 * - The poll opt-in/out knobs and their TELEGRAM_* aliases are stripped
 *   (both names are live input channels: the alias is read whenever the
 *   canonical is unset). The poller is default-off; tests that drive it
 *   opt in explicitly. An ambient opt-in would auto-start the poller in
 *   every child and race the live seat for the machine-wide getUpdates
 *   singleton; an ambient opt-out would suppress the poller paths the
 *   suite exercises.
 * - BRAID_TG_POLLER_LOCK_FILE is pinned to a per-file tmp path: the lock
 *   is machine-wide, so no child may touch the live seat's lock at the
 *   braid-home default. The TELEGRAM_POLLER_LOCK_FILE alias is stripped —
 *   once the canonical name is pinned, the alias is a redundant ambient
 *   input that could resurface in a test that unsets the canonical.
 * - BRAID_HOME is pinned to a per-file tmp path: every default braid state
 *   path (offset, live-update, downloaded media, pause state) resolves
 *   through it, so a test that forgets to pin its own state file writes
 *   into a fixture instead of the live seat's braid tree. Suites that
 *   assert the default tree set their own pin and restore it.
 *
 * Both pins live under the temp root in `base` (`TMPDIR`), not under this
 * process's own: a runner that gives the child a sandbox TMPDIR then owns the
 * tree the pins sit in, so removing the sandbox removes them too. Without an
 * explicit TMPDIR in `base`, that is os.tmpdir().
 *
 * Everything else passes through untouched; suites pin or delete their
 * own remaining inputs (credentials, cadence).
 */
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Ambient keys stripped from every test child (canonical + alias). */
export const STRIPPED_ENV_KEYS = [
  "BRAID_SESSION_ROLE",
  "BRAID_TG_POLL_ENABLED",
  "BRAID_TG_POLL_DISABLED",
  "TELEGRAM_POLL_ENABLED",
  "TELEGRAM_POLL_DISABLED",
  "TELEGRAM_POLLER_LOCK_FILE",
];

/** Neutral env for one test child: ambient stripped, marker set, own lock. */
export function childEnv(file, base = process.env) {
  const env = { ...base };
  for (const key of STRIPPED_ENV_KEYS) delete env[key];
  env.PI_BRAID_TELEGRAM_TEST = "1";
  const tempRoot = base.TMPDIR || tmpdir();
  env.BRAID_TG_POLLER_LOCK_FILE = join(
    tempRoot,
    `tg-poller-lock-${file}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  env.BRAID_HOME = join(
    tempRoot,
    `tg-braid-home-${file}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  return env;
}
