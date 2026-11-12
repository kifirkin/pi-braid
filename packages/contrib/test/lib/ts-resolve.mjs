/**
 * ts-resolve.mjs — a resolve hook that maps a relative `.js` specifier to its
 * sibling `.ts` when no `.js` file exists. The contrib sources import each
 * other with `.js` extensions (pi's loader resolves them); plain Node does
 * not, so the containment children need this to import the real modules
 * rather than a compiled copy. Only used by the test drivers.
 *
 * It also maps core's package export (`pi-braid/lib`) to this tree's core
 * build. Contrib sources import core that way, and in a checkout the bare
 * specifier resolves through node_modules to whichever pi-braid is linked
 * there, which is not the tree under test: a new core export would be
 * invisible to the extension that uses it, and the failure reads as a broken
 * import rather than as a stale link. The target is the built entry point
 * because that is what an installed extension loads; a missing build is
 * reported with the command that produces it.
 */
import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

/** packages/core/dist/lib/public.js, resolved relative to this hook. */
const CORE_PUBLIC = new URL(
  "../../../core/dist/lib/public.js",
  import.meta.url,
);

export async function resolve(specifier, context, nextResolve) {
  if (specifier === "pi-braid/lib") {
    const path = fileURLToPath(CORE_PUBLIC);
    if (!existsSync(path)) {
      throw new Error(
        `pi-braid/lib resolves to this tree's core build (${path}), which does not exist. ` +
          "Run `npm run build -w packages/core` first.",
      );
    }
    return { url: CORE_PUBLIC.href, shortCircuit: true };
  }
  if (
    (specifier.startsWith("./") || specifier.startsWith("../")) &&
    specifier.endsWith(".js") &&
    context.parentURL
  ) {
    const jsPath = fileURLToPath(new URL(specifier, context.parentURL));
    const tsPath = jsPath.replace(/\.js$/, ".ts");
    if (!existsSync(jsPath) && existsSync(tsPath)) {
      return { url: pathToFileURL(tsPath).href, shortCircuit: true };
    }
  }
  return nextResolve(specifier, context);
}
