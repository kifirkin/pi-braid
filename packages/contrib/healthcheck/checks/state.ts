import * as fs from "node:fs";
import * as path from "node:path";
import type { CheckResult } from "./types.js";
import { check } from "./helpers.js";
import { braidDir } from "../../state-paths.js";

/**
 * State probes target braid's own state root (`BRAID_HOME` when pinned, else
 * ~/.pi/agent/braid). Nothing above that root is ever created here: a missing
 * root is reported as the finding, because a healthcheck must not create the
 * directories it is inspecting (the probes used to mkdir ~/.pi and
 * ~/.pi/agent to test writability).
 */
export function testMemoryAndState(): CheckResult[] {
  const checks: CheckResult[] = [];

  // Test: braid state root exists
  checks.push(
    check("State", "braid-root", () => {
      const root = braidDir();
      if (root === null) {
        return {
          status: "fail",
          message:
            "braid state root is underivable: BRAID_HOME is unset and no absolute home resolves",
        };
      }
      if (!fs.existsSync(root)) {
        return { status: "fail", message: `braid state root missing: ${root}` };
      }
      return { status: "pass", message: `braid state root present: ${root}` };
    }),
  );

  // Test: braid state root is writable (real read-write-unlink cycle)
  checks.push(
    check("State", "braid-writable", () => {
      const root = braidDir();
      if (root === null) {
        return {
          status: "fail",
          message:
            "braid state root is underivable: BRAID_HOME is unset and no absolute home resolves",
        };
      }
      if (!fs.existsSync(root)) {
        return { status: "fail", message: `braid state root missing: ${root}` };
      }
      const testFile = path.join(root, ".hc-test");
      fs.writeFileSync(testFile, Date.now().toString());
      fs.unlinkSync(testFile);
      return { status: "pass", message: "braid state root writable" };
    }),
  );

  return checks;
}
