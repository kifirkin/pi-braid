/**
 * state-paths.test.ts — the contrib state-root mirror, and the real writers
 * through it.
 *
 * Run: node --experimental-strip-types state-paths.test.ts
 * (from the pi-braid root or this package). No network, no Chrome, no real
 * tunnel: the writers are the reconnect lock's exclusive create and the four
 * relocated writers, each driven in a child with BRAID_HOME pinned and the
 * cwd a throwaway project.
 *
 * Cases:
 *   1. the braid root is BRAID_HOME when pinned, else <home>/.pi/agent/braid
 *   2. every accessor resolves under the pin, none above it
 *   3. the reconnect lock lands under the pin while the cwd tree stays
 *      byte-for-byte unchanged (runtime containment)
 *   4. one containment child per relocated writer (observatory append,
 *      browser screenshot, browser scraping profile, healthcheck probe): the
 *      real write lands under the pin and neither the cwd nor the child HOME
 *      tree changes
 *   5. a hostile HOME ("" / "." / a relative path) refuses every default in a
 *      child, the real writer refuses, and the throwaway cwd gains nothing
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { acquireLock } from "./network-monitor/lock.ts";
import {
  braidDir,
  browserProfileDir,
  browserScreenshotsDir,
  observatorySessionsDir,
  reconnectLockFile,
} from "./state-paths.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REGISTER = path.join(HERE, "test/lib/register-ts-resolve.mjs");
const DRIVER = path.join(HERE, "test/writer-containment.mjs");
const HOSTILE_DRIVER = path.join(HERE, "test/hostile-home.mjs");

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
const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "contrib-state-home-"));
const savedPin = process.env.BRAID_HOME;
const savedCwd = process.cwd();

function treeOf(dir: string): string[] {
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .map((entry) => `${entry.name}:${entry.isDirectory() ? "dir" : "file"}`)
    .sort();
}

/** The observatory child needs recording enabled in ITS home's settings. */
function enableObservatoryRecording(): void {
  const settingsDir = path.join(homeDir, ".pi", "agent");
  fs.mkdirSync(settingsDir, { recursive: true });
  fs.writeFileSync(
    path.join(settingsDir, "settings.json"),
    JSON.stringify({ braid: { contrib: { observatory: { record: true } } } }),
  );
}

interface ChildRun {
  status: number | null;
  json: any;
  err: string;
}

/** Spawn one driver child: pinned BRAID_HOME, throwaway cwd and HOME. */
function runChild(
  driver: string,
  args: string[],
  env: NodeJS.ProcessEnv,
): ChildRun {
  const r = spawnSync(
    "node",
    ["--experimental-strip-types", "--import", REGISTER, driver, ...args],
    { cwd, encoding: "utf8", timeout: 120_000, env },
  );
  const lines = (r.stdout ?? "").trim().split("\n").filter(Boolean);
  let json: any = null;
  if (lines.length > 0) {
    try {
      json = JSON.parse(lines[lines.length - 1]);
    } catch {
      // leave json null
    }
  }
  return { status: r.status, json, err: r.stderr ?? "" };
}

/** Child env with the pin and the throwaway HOME (no ambient braid pin). */
function pinnedEnv(): NodeJS.ProcessEnv {
  return { ...process.env, BRAID_HOME: pin, HOME: homeDir };
}

try {
  // 1. unpinned: the default root is the agent-dir braid home
  delete process.env.BRAID_HOME;
  check(
    "unpinned braidDir is <home>/.pi/agent/braid",
    braidDir() === path.join(os.homedir(), ".pi", "agent", "braid"),
    String(braidDir()),
  );

  process.env.BRAID_HOME = pin;
  check("pinned braidDir is the pin", braidDir() === pin, String(braidDir()));

  // 2. every accessor under the pin, none above it
  const accessors: Array<[string, string | null]> = [
    ["observatorySessionsDir", observatorySessionsDir()],
    ["browserScreenshotsDir", browserScreenshotsDir()],
    ["browserProfileDir", browserProfileDir()],
    ["reconnectLockFile", reconnectLockFile()],
  ];
  for (const [name, resolved] of accessors) {
    check(
      `${name} resolves under the pin`,
      typeof resolved === "string" && resolved.startsWith(pin + path.sep),
      String(resolved),
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
  const lockFile = reconnectLockFile();
  if (lockFile === null)
    throw new Error("reconnectLockFile() is null under the pin");
  const lock = acquireLock(lockFile);
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

  // 4. one containment child per relocated writer
  enableObservatoryRecording();
  const homeTree = treeOf(homeDir);

  const observatory = runChild(DRIVER, ["observatory"], pinnedEnv());
  check(
    "observatory child exits 0",
    observatory.status === 0,
    observatory.err.slice(0, 400),
  );
  check(
    "observatory wrote one session file under the pin",
    observatory.json?.files?.length === 1 &&
      typeof observatory.json?.dir === "string" &&
      observatory.json.dir.startsWith(pin + path.sep),
    JSON.stringify(observatory.json),
  );
  check(
    "observatory child left the cwd tree unchanged",
    treeOf(cwd).join(",") === cwdTree.join(","),
  );
  check(
    "observatory child left the HOME tree unchanged",
    treeOf(homeDir).join(",") === homeTree.join(","),
  );

  const shot = runChild(DRIVER, ["browser-screenshot"], pinnedEnv());
  check(
    "browser-screenshot child exits 0",
    shot.status === 0,
    shot.err.slice(0, 400),
  );
  check(
    "screenshot saved under the pin (5 decoded bytes)",
    typeof shot.json?.saved?.filePath === "string" &&
      shot.json.saved.filePath.startsWith(pin + path.sep) &&
      shot.json.saved.bytes === 5 &&
      fs.existsSync(shot.json.saved.filePath),
    JSON.stringify(shot.json),
  );
  check(
    "browser-screenshot child left the cwd tree unchanged",
    treeOf(cwd).join(",") === cwdTree.join(","),
  );

  const profile = runChild(DRIVER, ["browser-profile"], pinnedEnv());
  check(
    "browser-profile child exits 0",
    profile.status === 0,
    profile.err.slice(0, 400),
  );
  check(
    "scraping profile created under the pin",
    typeof profile.json?.dir === "string" &&
      profile.json.dir.startsWith(pin + path.sep) &&
      profile.json.exists === true,
    JSON.stringify(profile.json),
  );
  check(
    "browser-profile child left the cwd tree unchanged",
    treeOf(cwd).join(",") === cwdTree.join(","),
  );

  const hcHome = fs.mkdtempSync(
    path.join(os.tmpdir(), "contrib-state-hchome-"),
  );
  const pinMtime = fs.statSync(pin).mtimeMs;
  const hc = runChild(DRIVER, ["healthcheck"], {
    ...process.env,
    BRAID_HOME: pin,
    HOME: hcHome,
  });
  check("healthcheck child exits 0", hc.status === 0, hc.err.slice(0, 400));
  check(
    "healthcheck probes all pass under the pin",
    Array.isArray(hc.json?.checks) &&
      hc.json.checks.length === 2 &&
      hc.json.checks.every((c: { status: string }) => c.status !== "fail"),
    JSON.stringify(hc.json),
  );
  // The probe is a real write into the pin: the directory's mtime moves. A
  // probe that writes elsewhere (or nowhere) leaves it alone.
  check(
    "healthcheck probe touched the pin (dir mtime moved)",
    fs.statSync(pin).mtimeMs !== pinMtime,
    String(fs.statSync(pin).mtimeMs),
  );
  check(
    "healthcheck probe left nothing under the pin",
    !fs.existsSync(path.join(pin, ".hc-test")),
  );
  check(
    "healthcheck child left the cwd tree unchanged",
    treeOf(cwd).join(",") === cwdTree.join(","),
  );
  check(
    "healthcheck child left its HOME tree unchanged",
    treeOf(hcHome).join(",") === "",
    treeOf(hcHome).join(","),
  );
  fs.rmSync(hcHome, { recursive: true, force: true });

  // 5. a hostile HOME refuses every default (and the real writer refuses)
  for (const hostile of ["", ".", "rel-home"]) {
    const hostileCwd = fs.mkdtempSync(
      path.join(os.tmpdir(), "contrib-hostile-cwd-"),
    );
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: hostile };
    delete env.BRAID_HOME;
    try {
      const r = spawnSync(
        "node",
        ["--experimental-strip-types", "--import", REGISTER, HOSTILE_DRIVER],
        { cwd: hostileCwd, env, encoding: "utf8", timeout: 120_000 },
      );
      const lines = (r.stdout ?? "").trim().split("\n").filter(Boolean);
      let json: any = null;
      if (lines.length > 0) {
        try {
          json = JSON.parse(lines[lines.length - 1]);
        } catch {
          // leave json null
        }
      }
      const label = `hostile HOME ${JSON.stringify(hostile)}`;
      check(
        `${label}: child exits 0`,
        r.status === 0,
        (r.stderr ?? "").slice(0, 400),
      );
      for (const [name, value] of Object.entries(json?.paths ?? {})) {
        check(
          `${label}: ${name} refuses (null)`,
          value === null,
          String(value),
        );
      }
      check(
        `${label}: the real writer refuses`,
        json?.saved === null,
        JSON.stringify(json?.saved),
      );
      check(
        `${label}: the cwd gained nothing`,
        fs.readdirSync(hostileCwd).length === 0,
        fs.readdirSync(hostileCwd).join(","),
      );
    } finally {
      fs.rmSync(hostileCwd, { recursive: true, force: true });
    }
  }
} finally {
  process.chdir(savedCwd);
  if (savedPin === undefined) delete process.env.BRAID_HOME;
  else process.env.BRAID_HOME = savedPin;
  fs.rmSync(pin, { recursive: true, force: true });
  fs.rmSync(cwd, { recursive: true, force: true });
  fs.rmSync(homeDir, { recursive: true, force: true });
}

process.stdout.write(
  `\nstate-paths: ${checks - failures}/${checks} checks passed\n`,
);
if (failures > 0) process.exitCode = 1;
