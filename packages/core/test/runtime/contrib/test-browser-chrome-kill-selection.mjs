/**
 * Stale-Chrome selection: a browser reset may only signal the scraping Chrome
 * it started, verified by its command line.
 *
 * WHY THIS TEST EXISTS:
 *   The reset used to list every process holding a socket on the debug port
 *   and SIGKILL each one. That listing is the listener *and every connected
 *   client*, so an agent driving the browser through CDP was SIGKILLed by its
 *   own reset. The reset now picks kill targets from a process listing and
 *   signals a pid only when its command line carries both
 *   `--remote-debugging-port=<port>` and `--user-data-dir=<scraping dir>`.
 *
 * WHAT THIS GATES:
 *   selectKillablePids() over synthetic `ps` output:
 *   - a flagged scraping Chrome is selected; the agent's own process and the
 *     owner's flagless Chrome are not, whatever holds the port;
 *   - the caller's pid is never selected, even on a line with both markers;
 *   - a Chrome helper (`--type=...`) is not selected; only the browser
 *     process that spawned it is;
 *   - a matching flag on a different port or a different profile is not
 *     selected;
 *   - quoted `--user-data-dir` values still match;
 *   - no match at all yields [] — there is no "kill something just in case"
 *     fallback.
 *
 * Run: node test/runtime/contrib/test-browser-chrome-kill-selection.mjs
 */

import { register } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

const HERE = dirname(fileURLToPath(import.meta.url));
const CDP_TS = join(HERE, "..", "..", "..", "..", "contrib", "browser", "cdp.ts");

// cdp.ts imports "../logger.js" while the file on disk is logger.ts; the
// loader teaches node the build-time `.js` -> `.ts` fallback for contrib.
register(
  new URL("../../helpers/contrib-ts-loader.mjs", import.meta.url).href,
  import.meta.url,
);

const { selectKillablePids } = await import(pathToFileURL(CDP_TS).href);

const PORT = 9222;
const PROFILE = "/srv/browser-tools";
const OPTIONS = { port: PORT, profileDir: PROFILE, selfPid: 1000 };

/** One `ps -ax -o pid=,command=` line. */
const line = (pid, command) => `  ${pid} ${command}`;

const SCRAPING_CHROME = `--remote-debugging-port=${PORT} --user-data-dir=${PROFILE}`;

describe("selectKillablePids", () => {
  it("selects only the flagged scraping Chrome, not the agent or the owner's Chrome", () => {
    const ps = [
      line(4242, `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome ${SCRAPING_CHROME} --no-first-run about:blank`),
      // The agent: holds a CDP client socket, so it has no debugging flag of
      // its own. Under the old port-based reset this line died.
      line(5150, "/opt/pi/bin/node /usr/local/bin/pi --model main"),
      // The owner's browser: no debugging flag, never a candidate.
      line(6262, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --user-data-dir=/srv/other-profile"),
    ].join("\n");

    assert.deepEqual(selectKillablePids(ps, OPTIONS), [4242]);
  });

  it("never selects the caller's own pid, even with matching flags", () => {
    const ps = [
      line(1000, `/opt/pi/bin/node ${SCRAPING_CHROME} --model main`),
      line(4242, `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome ${SCRAPING_CHROME}`),
    ].join("\n");

    assert.deepEqual(selectKillablePids(ps, OPTIONS), [4242]);
  });

  it("skips Chrome helper processes; the browser process is the target", () => {
    const helper = `--type=renderer ${SCRAPING_CHROME} --renderer-client-id=6`;
    const ps = [
      line(4242, `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome ${SCRAPING_CHROME} about:blank`),
      line(4343, `/Applications/Google Chrome.app/Contents/Frameworks/Google Chrome Helper (Renderer) ${helper}`),
    ].join("\n");

    assert.deepEqual(selectKillablePids(ps, OPTIONS), [4242]);
  });

  it("ignores a matching flag on a different port or profile", () => {
    const ps = [
      line(4242, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --remote-debugging-port=9333 --user-data-dir=/srv/browser-tools"),
      line(5252, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --remote-debugging-port=9222 --user-data-dir=/srv/other-profile"),
      line(6262, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --remote-debugging-port=9222"),
    ].join("\n");

    assert.deepEqual(selectKillablePids(ps, OPTIONS), []);
  });

  it("matches a quoted --user-data-dir value", () => {
    const ps = line(4242, `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --remote-debugging-port=${PORT} --user-data-dir="${PROFILE}"`);
    assert.deepEqual(selectKillablePids(ps, OPTIONS), [4242]);
  });

  it("returns nothing when no process matches — no just-in-case fallback", () => {
    const ps = [
      line(4242, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --user-data-dir=/srv/other-profile"),
      line(5252, "/opt/pi/bin/node /usr/local/bin/pi --model main"),
      "",
      "not a ps line",
    ].join("\n");

    assert.deepEqual(selectKillablePids(ps, OPTIONS), []);
  });

  it("never targets pid 1", () => {
    const ps = [
      line(1, `/sbin/launchd`),
      line(4242, `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome ${SCRAPING_CHROME}`),
    ].join("\n");

    assert.deepEqual(selectKillablePids(ps, OPTIONS), [4242]);
  });
});
