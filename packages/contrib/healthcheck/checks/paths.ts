import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { CheckResult } from "./types.js";
import { check } from "./helpers.js";

export function testPathOperations(): CheckResult[] {
  const checks: CheckResult[] = [];

  // Test: CWD accessible
  checks.push(
    check("Paths", "cwd", () => {
      const cwd = process.cwd();
      const stat = fs.statSync(cwd);
      if (!stat.isDirectory()) {
        return { status: "fail", message: "CWD is not a directory" };
      }
      return { status: "pass", message: `CWD OK: ${cwd}` };
    }),
  );

  // Test: PATH resolution
  checks.push(
    check("Paths", "env-PATH", () => {
      const p = process.env.PATH;
      if (!p) {
        return { status: "fail", message: "PATH not set" };
      }
      const dirs = p.split(path.delimiter).filter((d) => fs.existsSync(d));
      return {
        status: "pass",
        message: `PATH has ${dirs.length} valid directories`,
      };
    }),
  );

  // Test: Platform info
  checks.push(
    check("Paths", "platform", () => {
      const platform = os.platform();
      const arch = os.arch();
      return { status: "pass", message: `${platform}/${arch}` };
    }),
  );

  return checks;
}
