/**
 * state-paths.test.ts — the contrib state-root mirror, and a real writer
 * through it.
 *
 * Run: node --experimental-strip-types state-paths.test.ts
 * (from the pi-braid root or this package). No network, no real tunnel: the
 * writer exercised here is the reconnect lock's atomic exclusive create.
 *
 * Cases:
 *   1. the braid root is BRAID_HOME when pinned, else <home>/.pi/agent/braid
 *   2. every accessor resolves under the pin, none above it
 *   3. the reconnect lock lands under the pin while the cwd tree stays
 *      byte-for-byte unchanged (runtime containment)
 *   4. a read-write-unlink cycle under the braid root leaves nothing behind
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { acquireLock } from "./network-monitor/lock.ts";
import {
  braidDir,
  browserProfileDir,
  browserScreenshotsDir,
  observatorySessionsDir,
  reconnectLockFile,
} from "./state-paths.ts";

let failures = 0;
let checks = 0;

function check(name: string, cond: boolean, detail?: string): void {
  checks += 1;
  if (!cond) {
    failures += 1;
    console.error(`  FAIL ${name}${detail ? `: ${detail}` : ""}`);
  } else {
    process.stdout.write(`  ok ${name}\n`);
  }
}

const pin = fs.mkdtempSync(path.join(os.tmpdir(), "contrib-state-pin-"));
const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "contrib-state-cwd-"));
const savedPin = process.env.BRAID_HOME;
const savedCwd = process.cwd();

function treeOf(dir: string): string[] {
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .map((entry) => `${entry.name}:${entry.isDirectory() ? "dir" : "file"}`)
    .sort();
}

try {
  // 1. unpinned: the default root is the agent-dir braid home
  delete process.env.BRAID_HOME;
  check(
    "unpinned braidDir is <home>/.pi/agent/braid",
    braidDir() === path.join(os.homedir(), ".pi", "agent", "braid"),
    braidDir(),
  );

  process.env.BRAID_HOME = pin;
  check("pinned braidDir is the pin", braidDir() === pin, braidDir());

  // 2. every accessor under the pin, none above it
  const accessors: Array<[string, string]> = [
    ["observatorySessionsDir", observatorySessionsDir()],
    ["browserScreenshotsDir", browserScreenshotsDir()],
    ["browserProfileDir", browserProfileDir()],
    ["reconnectLockFile", reconnectLockFile()],
  ];
  for (const [name, resolved] of accessors) {
    check(
      `${name} resolves under the pin`,
      resolved.startsWith(pin + path.sep),
      resolved,
    );
  }
  check(
    "observatory sessions sit under the observatory dir",
    observatorySessionsDir() === path.join(pin, "observatory", "sessions"),
  );
  check(
    "screenshots and profile sit under the browser dir",
    browserScreenshotsDir() === path.join(pin, "browser", "screenshots") &&
      browserProfileDir() === path.join(pin, "browser", "profile-scratch"),
  );

  // 3. runtime containment: a real writer through the pinned path
  process.chdir(cwd);
  const cwdTree = treeOf(cwd);
  const lock = acquireLock(reconnectLockFile());
  check(
    "reconnect lock acquired",
    lock.acquired,
    lock.acquired ? "" : lock.reason,
  );
  const lockPath = path.join(pin, "network-monitor", "reconnect.lock");
  check("reconnect lock exists under the pin", fs.existsSync(lockPath));
  check(
    "reconnect lock is the one just taken",
    JSON.parse(fs.readFileSync(lockPath, "utf8")).pid === process.pid,
  );
  check(
    "cwd tree is unchanged by the lock",
    treeOf(cwd).join(",") === cwdTree.join(","),
  );
  check("no .pi directory in the cwd", !fs.existsSync(path.join(cwd, ".pi")));
  if (lock.acquired) lock.release();
  check("release removes the lock", !fs.existsSync(lockPath));

  // 4. the healthcheck probe shape: read-write-unlink, nothing left behind
  const probe = path.join(braidDir(), ".hc-test");
  fs.writeFileSync(probe, "probe");
  check("probe write is readable", fs.readFileSync(probe, "utf8") === "probe");
  fs.unlinkSync(probe);
  check("probe leaves nothing behind", !fs.existsSync(probe));
  check(
    "cwd tree is unchanged by the probe",
    treeOf(cwd).join(",") === cwdTree.join(","),
  );
} finally {
  process.chdir(savedCwd);
  if (savedPin === undefined) delete process.env.BRAID_HOME;
  else process.env.BRAID_HOME = savedPin;
  fs.rmSync(pin, { recursive: true, force: true });
  fs.rmSync(cwd, { recursive: true, force: true });
}

process.stdout.write(
  `\nstate-paths: ${checks - failures}/${checks} checks passed\n`,
);
if (failures > 0) process.exitCode = 1;
