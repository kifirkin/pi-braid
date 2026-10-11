/**
 * Append-only file sink for network-monitor log lines.
 *
 * The contrib logger is process-local: its buffer dies with the process and
 * its console sink is silent by design, so a watcher's actions leave no
 * record to audit after the fact. This sink appends one line per event to a
 * user-configured path using the append flag - it never truncates and never
 * rotates. A write failure disables the sink instead of throwing into the
 * probe loop.
 */

import * as fs from "node:fs";
import * as path from "node:path";

export type SinkLevel = "debug" | "info" | "warn" | "error";

export interface LogFileSink {
  append(level: SinkLevel, message: string): void;
}

/**
 * Build a sink for `filePath`; null when the path is empty. The directory
 * is created on first write, so a configured-but-unused path costs nothing.
 */
export function createLogFileSink(filePath: string): LogFileSink | null {
  const target = filePath.trim();
  if (target.length === 0) return null;
  let disabled = false;
  let dirReady = false;
  return {
    append(level: SinkLevel, message: string): void {
      if (disabled) return;
      try {
        if (!dirReady) {
          fs.mkdirSync(path.dirname(target), { recursive: true });
          dirReady = true;
        }
        fs.appendFileSync(
          target,
          `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} ${message}\n`,
        );
      } catch {
        disabled = true;
      }
    },
  };
}
