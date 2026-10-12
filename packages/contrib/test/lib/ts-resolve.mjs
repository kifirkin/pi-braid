/**
 * ts-resolve.mjs — a resolve hook that maps a relative `.js` specifier to its
 * sibling `.ts` when no `.js` file exists. The contrib sources import each
 * other with `.js` extensions (pi's loader resolves them); plain Node does
 * not, so the containment children need this to import the real modules
 * rather than a compiled copy. Only used by the test drivers.
 */
import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

export async function resolve(specifier, context, nextResolve) {
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
