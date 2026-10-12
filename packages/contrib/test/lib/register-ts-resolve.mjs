/**
 * register-ts-resolve.mjs — loads the `.js` -> `.ts` resolve hook for a child
 * process spawned with `--import <this file>`.
 */
import { register } from "node:module";

register(new URL("./ts-resolve.mjs", import.meta.url));
