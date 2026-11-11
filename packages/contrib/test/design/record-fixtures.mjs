/**
 * Regenerate the recorded snapshots from the fixture pages.
 *
 * This is not part of the test: the gate reads the JSON files and needs no
 * browser. Run it when a fixture page changes, with Chrome reachable on the
 * debugging port, then review the snapshot diff before committing it.
 *
 *   node --experimental-strip-types --import ./test/lib/register-ts-resolve.mjs \
 *     test/design/record-fixtures.mjs
 */

import { register } from "node:module";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

register(new URL("../lib/ts-resolve.mjs", import.meta.url));

const HERE = dirname(fileURLToPath(import.meta.url));
const CONTRIB = join(HERE, "..", "..");
const WIDTHS = [320, 390, 768, 1440];

const { capturePage } = await import(
  pathToFileURL(join(CONTRIB, "design", "adapter.ts")).href
);

for (const name of ["defects", "clean"]) {
  const directory = join(HERE, "fixtures", name);
  const result = await capturePage(join(directory, "page.html"), {
    widths: WIDTHS,
    screenshotDir: null,
  });
  const snapshots = {};
  for (const width of result.widths) {
    // A committed snapshot must not carry the recorder's own file URL; the
    // path below is stable across checkouts.
    snapshots[String(width.snapshot.viewportWidth)] = {
      ...width.snapshot,
      url: `test/design/fixtures/${name}/page.html`,
    };
  }
  writeFileSync(
    join(directory, "snapshots.json"),
    `${JSON.stringify(snapshots, null, 2)}\n`,
  );
  console.log(
    `${name}: ${result.widths.length} widths, ${result.widths[0].snapshot.nodes.length} nodes each`,
  );
}
