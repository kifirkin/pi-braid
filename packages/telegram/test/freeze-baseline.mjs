/**
 * Regenerate test/fixtures/telegram-format-baseline.json.
 *
 * The baseline is a characterization snapshot, not an independent correctness
 * expectation: it records how the package delivered every hostile corpus body
 * in the three requested modes before the delivery hardening, and the corpus
 * runner uses it only to decide which wires changed (EXPECTED_WIRES pins the
 * exact before/after wires).
 *
 * Usage: node test/freeze-baseline.mjs <checkout-with-dist>
 *
 * <checkout-with-dist> is a checkout of the revision before the hardening,
 * built with `npm run build` (so `packages/telegram/dist/lib/format.js`
 * exists). The committed baseline was generated from the revision recorded in
 * its `note`.
 */
import { writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { HOSTILE_CASES } from "./fixtures/telegram-format-corpus.mjs";

const target = process.argv[2];
if (!target) {
  console.error(
    "usage: node test/freeze-baseline.mjs <checkout-with-dist>  (dist = npm run build)",
  );
  process.exit(2);
}
const before = await import(
  pathToFileURL(join(resolve(target), "packages/telegram/dist/lib/format.js"))
    .href
);

const modes = [undefined, "Markdown", "HTML"];
const out = {
  note: "delivery of the hostile corpus at the revision before the hardening (HEAD 7b1337b9); regenerate with test/freeze-baseline.mjs <checkout-with-dist>",
  cases: {},
};
for (const { name, body } of HOSTILE_CASES) {
  out.cases[name] = modes.map((requested) => {
    const result = before.resolveDeliveryFormat(requested, body);
    return {
      requested: requested ?? "none",
      mode: result.parseMode ?? "plain",
      text: result.text,
      converted: result.converted ?? null,
    };
  });
}
const file = join(
  dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "telegram-format-baseline.json",
);
writeFileSync(file, JSON.stringify(out, null, 2) + "\n");
console.log(
  `baseline written: cases=${Object.keys(out.cases).length} modes=${modes.length}`,
);
