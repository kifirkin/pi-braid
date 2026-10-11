#!/usr/bin/env node
/**
 * End-to-end proof that the browser reset cannot kill its caller.
 *
 * The defect: the reset listed every process holding a socket on the debug
 * port with `lsof` and piped those pids into `kill -9`. That listing is the
 * Chrome listener *and every connected CDP client*, so an agent driving the
 * browser through CDP was SIGKILLed by its own reset.
 *
 * This probe runs the real code against real processes:
 *
 *   before  reproduces the defect on an isolated port. A child process opens
 *           a real client socket to the debug port, then runs the legacy
 *           pipeline verbatim. The child must die on SIGKILL — the mechanism
 *           that killed the worker.
 *   after   spawns a real Chrome on an isolated port, opens a real client
 *           socket from this process, calls the real
 *           killStaleScrapingChrome(), and asserts the caller survived and
 *           the scraping Chrome is gone. Two decoy processes carry one marker
 *           each (the port flag without the profile, the profile without the
 *           flag) and must survive, proving the both-markers condition
 *           end-to-end.
 *   live    (--live) the same check against the real :9222 scraping Chrome in
 *           ~/.cache/browser-tools, plus the assertion that the owner's
 *           flagless Chrome processes are left untouched. The scraping Chrome
 *           is respawned afterwards.
 *
 * The legacy pipeline only ever runs on an isolated port: running it on :9222
 * would kill every client there, which is the very hazard under test.
 *
 * Usage:
 *   node test/manual/probe-browser-chrome-reset.mjs
 *   node test/manual/probe-browser-chrome-reset.mjs --live
 */

import { execSync, spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { register } from "node:module";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..", "..", "..");
const CDP_TS = join(REPO, "packages", "contrib", "browser", "cdp.ts");

register(new URL("../helpers/contrib-ts-loader.mjs", import.meta.url).href, import.meta.url);
const { spawnChrome, killStaleScrapingChrome, selectKillablePids } = await import(
  pathToFileURL(CDP_TS).href
);

const ISOLATED_PORT = 9555;
const LIVE_PORT = 9222;
const LIVE_PROFILE = `${process.env.HOME ?? ""}/.cache/browser-tools`;

const LEGACY_RESET = (port) => `lsof -t -i :${port} | xargs kill -9 2>/dev/null || true`;

let failures = 0;
function check(name, cond, detail = "") {
  const ok = Boolean(cond);
  if (!ok) failures += 1;
  console.log(`  ${ok ? "[v]" : "[x]"} ${name}${detail ? ` — ${detail}` : ""}`);
}

/**
 * Whether the pid names a live process. A process we SIGKILLed but never
 * reaped lingers as a zombie for which `kill -0` still succeeds; a zombie is
 * dead for every purpose this probe asserts.
 */
const alive = (pid) => {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  try {
    const state = execSync(`ps -ww -p ${pid} -o state=`, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return state !== "" && !state.startsWith("Z");
  } catch {
    return false;
  }
};

/** Poll until the pid is gone, so a kill reaped a beat later still counts. */
async function waitGone(pid, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!alive(pid)) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return !alive(pid);
}

const psOutput = () => execSync("ps -ww -ax -o pid=,command=", { encoding: "utf8" });

/** Chrome browser processes with no debugging flag: never a reset target. */
const flaglessChromePids = () =>
  psOutput()
    .split("\n")
    .filter((line) => /\/MacOS\/Google Chrome (?!Helper)/.test(line) && !line.includes("--remote-debugging-port="))
    .map((line) => Number(line.match(/^\s*(\d+)/)?.[1]))
    .filter((pid) => Number.isInteger(pid) && pid > 1);

/** A real (raw TCP) client connection to the debug port, held open. */
function openClientSocket(port) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, "127.0.0.1");
    socket.once("connect", () => resolve(socket));
    socket.once("error", reject);
  });
}

/**
 * Wait for Chrome to answer on the port, then return true (false at the
 * deadline). Uses a raw HTTP/1.1 request with `Connection: close` and lets
 * the socket die: a keep-alive client socket left on the port would itself be
 * a kill target under the legacy pipeline, so the harness must not add
 * candidates.
 */
function waitPort(port, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve) => {
    const attempt = () => {
      const socket = net.connect(port, "127.0.0.1");
      let settled = false;
      let buf = "";
      const retry = () => {
        if (settled) return;
        settled = true;
        socket.destroy();
        if (Date.now() > deadline) resolve(false);
        else setTimeout(attempt, 300);
      };
      socket.setTimeout(2000);
      socket.on("connect", () =>
        socket.write(`GET /json/version HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\n\r\n`),
      );
      socket.on("data", (d) => {
        buf += d;
      });
      socket.on("close", () => {
        if (buf.includes("200 OK")) {
          settled = true;
          resolve(true);
        } else retry();
      });
      socket.on("error", retry);
      socket.on("timeout", retry);
    };
    attempt();
  });
}

const reachable = (port) => waitPort(port, 3000);

/** Poll until no process mentions the debugging flag for the port. */
async function waitNoProcessesMentioningFlag(port, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const out = execSync(`pgrep -f -- "--remote-debugging-port=${port}" || true`, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (out === "") return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

/**
 * A long-lived process that carries one marker on its command line but not
 * both, so a correct reset must leave it running.
 */
function spawnDecoy(extraArgs) {
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 20000)", "--", ...extraArgs], {
    stdio: "ignore",
  });
  return child;
}

async function main() {
  console.log("=== browser reset kill-safety probe ===\n");

  // ── BEFORE: the legacy pipeline kills the process that holds a client ──
  console.log(`before: legacy reset on isolated :${ISOLATED_PORT}`);
  const beforeDir = mkdtempSync(join(tmpdir(), "probe-before-"));
  await spawnChrome({ port: ISOLATED_PORT, profileDir: beforeDir });
  check("scratch Chrome answers on the isolated port", await waitPort(ISOLATED_PORT));
  const beforeChrome = selectKillablePids(psOutput(), {
    port: ISOLATED_PORT,
    profileDir: beforeDir,
    selfPid: process.pid,
  });
  check("scratch Chrome is up and selected", beforeChrome.length === 1, `pids=${beforeChrome}`);

  const childScript = `
    const net = require("node:net");
    const { execSync } = require("node:child_process");
    const PORT = ${ISOLATED_PORT};
    const s = net.connect(PORT, "127.0.0.1", () => {
      execSync(${JSON.stringify(LEGACY_RESET(ISOLATED_PORT))}, { stdio: "ignore" });
      setTimeout(() => { console.log("CLIENT-ALIVE"); process.exit(0); }, 800);
    });
    s.on("error", () => {});
  `;
  const child = spawnSync(process.execPath, ["-e", childScript], { encoding: "utf8" });
  check(
    "legacy reset SIGKILLs the client that calls it (defect reproduced)",
    child.signal === "SIGKILL",
    `signal=${child.signal ?? "none"} status=${child.status}`,
  );
  check("legacy reset also killed the Chrome listener", await waitGone(beforeChrome[0]));
  rmSync(beforeDir, { recursive: true, force: true });

  // ── AFTER: the new reset spares the client, the caller, and the decoys ──
  console.log(`\nafter: new reset on isolated :${ISOLATED_PORT}`);
  const afterDir = mkdtempSync(join(tmpdir(), "probe-after-"));
  await spawnChrome({ port: ISOLATED_PORT, profileDir: afterDir });
  check("scratch Chrome answers on the isolated port", await waitPort(ISOLATED_PORT));
  const afterChrome = selectKillablePids(psOutput(), {
    port: ISOLATED_PORT,
    profileDir: afterDir,
    selfPid: process.pid,
  });
  check("scratch Chrome is up and selected", afterChrome.length === 1, `pids=${afterChrome}`);

  const decoyPortOnly = spawnDecoy([`--remote-debugging-port=${ISOLATED_PORT}`]);
  const decoyProfileOnly = spawnDecoy([`--user-data-dir=${afterDir}`]);
  await new Promise((r) => setTimeout(r, 300));

  const socket = await openClientSocket(ISOLATED_PORT);
  check("this process holds an open client socket to the debug port", socket.readyState === "open");

  const killed = killStaleScrapingChrome({ port: ISOLATED_PORT, profileDir: afterDir });
  check(
    "new reset killed exactly the scraping Chrome",
    JSON.stringify(killed) === JSON.stringify(afterChrome),
    `killed=${killed}`,
  );
  check("scraping Chrome is gone", await waitGone(afterChrome[0]));
  check("the calling process survived", alive(process.pid) && process.pid > 1);
  check("a process with the port flag but no profile survived", alive(decoyPortOnly.pid));
  check("a process with the profile but no port flag survived", alive(decoyProfileOnly.pid));
  socket.destroy();
  decoyPortOnly.kill("SIGKILL");
  decoyProfileOnly.kill("SIGKILL");
  rmSync(afterDir, { recursive: true, force: true });

  // ── LIVE: the real :9222 scraping Chrome ──
  const live = process.argv.includes("--live");
  console.log(`\nlive: real :${LIVE_PORT}${live ? "" : " (skipped; pass --live)"}`);
  if (live) {
    check("a Chrome is listening on the live port", await reachable(LIVE_PORT));

    const ownerPids = flaglessChromePids();
    const targets = selectKillablePids(psOutput(), {
      port: LIVE_PORT,
      profileDir: LIVE_PROFILE,
      selfPid: process.pid,
    });
    check(
      "exactly the scraping browser process is selected (helpers excluded)",
      targets.length === 1,
      `targets=${targets}`,
    );

    if (targets.length === 1) {
      const liveSocket = await openClientSocket(LIVE_PORT);
      check("this process holds an open client socket to the live debug port", liveSocket.readyState === "open");

      const killedLive = killStaleScrapingChrome({ port: LIVE_PORT, profileDir: LIVE_PROFILE });
      check("the live scraping Chrome is gone", await waitGone(killedLive[0]), `killed=${killedLive}`);
      check("the calling process survived the live reset", alive(process.pid));
      if (ownerPids.length === 0) {
        console.log("  [ ] the owner's flagless Chrome: none running (check vacuous)");
      } else {
        check(
          "the owner's flagless Chrome processes were untouched",
          ownerPids.every((pid) => alive(pid)),
          `owner pids=${ownerPids}`,
        );
      }
      liveSocket.destroy();

      // Restore the environment the reset is expected to maintain. A
      // SIGKILLed Chrome leaves helpers that briefly hold the profile
      // singleton; wait them out so the replacement does not hand off to a
      // dying instance and exit.
      await waitNoProcessesMentioningFlag(LIVE_PORT);
      await spawnChrome({ port: LIVE_PORT, profileDir: LIVE_PROFILE });
      check("a fresh scraping Chrome is listening again on the live port", await reachable(LIVE_PORT));
    }
  }

  console.log(`\n${failures === 0 ? "PASS" : "FAIL"} — ${failures} failing check(s)`);
  // Exit explicitly: spawnChrome opens the Chrome stdio pipes, and while a
  // replacement Chrome runs they keep the event loop alive, so returning
  // would leave the process hanging after the last check.
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(`probe crashed: ${err.stack ?? err}`);
  process.exit(2);
});
