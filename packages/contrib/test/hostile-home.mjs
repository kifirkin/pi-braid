/**
 * hostile-home.mjs — child driver for state-paths.test.ts's hostile-HOME
 * cases. Runs with HOME="" / "." / a relative path, BRAID_HOME unset and a
 * throwaway cwd, and prints one JSON line: every accessor's resolution plus
 * the result of a real writer (the screenshot save) through the mirror.
 *
 * Not a test file: state-paths.test.ts spawns it.
 */
import * as os from "node:os";

const paths = await import("../state-paths.ts");
const accessors = [
  "braidDir",
  "observatorySessionsDir",
  "browserScreenshotsDir",
  "browserProfileDir",
  "reconnectLockFile",
];
const resolved = {};
for (const name of accessors) resolved[name] = paths[name]();

const { saveScreenshotToFile } = await import("../browser/index.ts");
const saved = saveScreenshotToFile("aGVsbG8=", "png");

process.stdout.write(
  JSON.stringify({ homedir: os.homedir(), paths: resolved, saved }) + "\n",
);
