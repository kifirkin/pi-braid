/**
 * state-path-mirrors-child.mjs — child driver for
 * test-state-path-mirrors.mjs. Imports all four braid-root mirrors (core,
 * providers, telegram, contrib) and prints one JSON line: for every
 * (HOME, BRAID_HOME) variant, what each mirror resolves.
 *
 * The parent asserts the four agree on every variant, so drift between the
 * copies fails a test. Core's braidDir() throws on a refusal and the mirrors
 * return null; the driver normalizes both to null.
 *
 * Not a test: lives outside test/runtime so the runner does not execute it.
 */
import { pathToFileURL } from "node:url";

const [corePath, providersPath, telegramPath, contribPath, absHome] =
  process.argv.slice(2);

const core = await import(pathToFileURL(corePath).href);
const providers = await import(pathToFileURL(providersPath).href);
const telegram = await import(pathToFileURL(telegramPath).href);
const contrib = await import(pathToFileURL(contribPath).href);

/** The four mirrors, by package. */
const mirrors = [
  ["core", core.braidDir],
  ["providers", providers.braidDataRoot],
  ["telegram", telegram.braidDir],
  ["contrib", contrib.braidDir],
];

const HOME_VARIANTS = [
  ["absolute", absHome],
  ["empty", ""],
  ["dot", "."],
  ["relative", "rel-home"],
];
const BRAID_VARIANTS = [
  ["unset", undefined],
  ["absolute", absHome],
  ["dot", "."],
  ["relative", "rel/sub"],
  ["blank", ""],
  ["whitespace", "   "],
  ["tilde", "~/braid"],
];

const rows = [];
for (const [homeName, home] of HOME_VARIANTS) {
  process.env.HOME = home;
  for (const [braidName, braid] of BRAID_VARIANTS) {
    if (braid === undefined) delete process.env.BRAID_HOME;
    else process.env.BRAID_HOME = braid;
    const cells = {};
    for (const [name, fn] of mirrors) {
      try {
        cells[name] = fn() ?? null;
      } catch {
        cells[name] = null; // core refuses by throwing
      }
    }
    rows.push({ home: homeName, braid: braidName, cells });
  }
}

process.stdout.write(
  JSON.stringify({ cwd: process.cwd(), absHome, rows }) + "\n",
);
