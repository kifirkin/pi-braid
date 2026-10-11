/**
 * Test-only ESM loader for driving packages/contrib sources in-process.
 *
 * Two resolutions differ from the runtime graph inside a worktree:
 *
 *  - `pi-braid/lib` resolves through the shared `node_modules` symlink to the
 *    main checkout's built dist, not the worktree under test. Redirect it to
 *    this worktree's core dist so a contrib test exercises the code it is
 *    meant to verify.
 *  - Contrib sources import `./sibling.js` while the file on disk is
 *    `sibling.ts` (tsc rewrites the extension at build time, and contrib has no
 *    build step). Fall back to the `.ts` specifier.
 *
 * Not a test: lives outside test/runtime so the runner does not execute it.
 */
export async function resolve(specifier, context, nextResolve) {
  if (specifier === "pi-braid/lib") {
    return { url: new URL("../../dist/lib/public.js", import.meta.url).href, shortCircuit: true };
  }
  try {
    return await nextResolve(specifier, context);
  } catch (err) {
    if (err && err.code === "ERR_MODULE_NOT_FOUND" && specifier.endsWith(".js")) {
      return await nextResolve(specifier.slice(0, -3) + ".ts", context);
    }
    throw err;
  }
}
