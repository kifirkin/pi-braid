/**
 * state-path-mirrors-child.mjs — child driver for
 * test-state-path-mirrors.mjs. Imports all four braid-root mirrors (core,
 * providers, telegram, contrib) and prints one JSON line: for every
 * (HOME, BRAID_HOME) variant, what each mirror resolves and HOW it refused.
 *
 * The parent asserts the four agree on every variant, so drift between the
 * copies fails a test. Core's braidDir() throws on a refusal and the mirrors
 * return null; the driver keeps both the normalized value (`cells`, null for
 * either refusal) and the per-package class (`classes`: "value" | "null" |
 * "throw"), so the parent can pin the class contract the normalization would
 * otherwise hide.
 *
 * The variant list is the matrix the parent counts and pins: seven HOME shapes
 * (absolute, absolute-but-missing, absolute-naming-a-file, whitespace-padded
 * absolute, empty, dot, relative) against ten BRAID_HOME shapes (unset,
 * absolute, the same three absolute rarities, dot, relative, blank,
 * whitespace-only, tilde-spelled). The three rarities are the shapes whose
 * behaviour nothing pinned before: no existence or file-type check is made on
 * a root, and a padded absolute is refused because it is not absolute as read.
 *
 * Not a test: lives outside test/runtime so the runner does not execute it.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
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

// The three absolute rarities, built inside the throwaway HOME the parent
// hands over (it removes that tree, so nothing is left in tmp): a path that
// does not exist, a path that is a file, and one of each with padding around
// it.
const absentHome = join(absHome, "absent-home");
const fileHome = join(absHome, "home-file");
writeFileSync(fileHome, "not a directory\n");
const absentBraid = join(absHome, "absent-braid");
const fileBraid = join(absHome, "braid-file");
writeFileSync(fileBraid, "not a directory\n");

const HOME_VARIANTS = [
  ["absolute", absHome],
  ["absolute-missing", absentHome],
  ["absolute-file", fileHome],
  ["whitespace-padded-absolute", ` ${absHome} `],
  ["empty", ""],
  ["dot", "."],
  ["relative", "rel-home"],
];
const BRAID_VARIANTS = [
  ["unset", undefined],
  ["absolute", absHome],
  ["absolute-missing", absentBraid],
  ["absolute-file", fileBraid],
  ["padded-absolute", ` ${absHome} `],
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
    const classes = {};
    for (const [name, fn] of mirrors) {
      try {
        const value = fn();
        cells[name] = value ?? null;
        classes[name] = value === null || value === undefined ? "null" : "value";
      } catch {
        cells[name] = null; // core refuses by throwing
        classes[name] = "throw";
      }
    }
    rows.push({ home: homeName, braid: braidName, cells, classes });
  }
}

process.stdout.write(
  JSON.stringify({
    cwd: process.cwd(),
    absHome,
    shapes: {
      absentHome,
      fileHome,
      absentBraid,
      fileBraid,
    },
    homeVariants: HOME_VARIANTS.map(([name]) => name),
    braidVariants: BRAID_VARIANTS.map(([name]) => name),
    rows,
  }) + "\n",
);
