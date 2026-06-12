/**
 * Error Guard - Consistent error handling helper.
 *
 * Wraps an async function with try/catch logging.
 * Replaces empty catch blocks with at-minimum-logged errors.
 *
 * Usage:
 *   await guard("handler-registry:register-session-start", () => pi.on(...), log);
 *   await guard("my-module:risky-op", () => doSomething(), log);
 *   const result = await guard("my-module:fetch-data", () => fetchData(), log);
 *   if (result === undefined) { handle failure }
 */

import type { Logger } from "../core/logger.js";

export async function guard<T>(
  label: string,
  fn: () => Promise<T>,
  log: Logger,
): Promise<T | undefined> {
  try {
    return await fn();
  } catch (err) {
    log.error(`${label}: ${(err as Error).message}`);
    return undefined;
  }
}
