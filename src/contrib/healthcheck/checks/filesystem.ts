import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { CheckResult } from "./types.js";
import { HC_DIR, ensureHcDir, check } from "./helpers.js";

export function testFilesystem(): CheckResult[] {
  const checks: CheckResult[] = [];

  // Test: Write file
  checks.push(
    check("Filesystem", "write", () => {
      ensureHcDir();
      const testFile = path.join(HC_DIR, "write-test.txt");
      fs.writeFileSync(testFile, "healthcheck write test");
      const read = fs.readFileSync(testFile, "utf-8");
      if (read !== "healthcheck write test") {
        return { status: "fail", message: "Write succeeded but content mismatch" };
      }
      return { status: "pass", message: "Write and verify OK" };
    }),
  );

  // Test: Read file
  checks.push(
    check("Filesystem", "read", () => {
      const testFile = path.join(HC_DIR, "write-test.txt");
      if (!fs.existsSync(testFile)) {
        return { status: "fail", message: "Test file not found (write failed?)" };
      }
      const content = fs.readFileSync(testFile, "utf-8");
      return { status: "pass", message: `Read OK (${content.length} bytes)` };
    }),
  );

  // Test: Append/modify file
  checks.push(
    check("Filesystem", "modify", () => {
      const testFile = path.join(HC_DIR, "write-test.txt");
      const original = fs.readFileSync(testFile, "utf-8");
      fs.writeFileSync(testFile, `${original}\nappended`);
      const modified = fs.readFileSync(testFile, "utf-8");
      if (!modified.includes("appended")) {
        return { status: "fail", message: "Append failed" };
      }
      return { status: "pass", message: "Modify OK" };
    }),
  );

  // Test: Create directory
  checks.push(
    check("Filesystem", "mkdir", () => {
      const testDir = path.join(HC_DIR, "test-subdir");
      if (fs.existsSync(testDir)) {
        fs.rmSync(testDir, { recursive: true });
      }
      fs.mkdirSync(testDir, { recursive: true });
      if (!fs.existsSync(testDir)) {
        return { status: "fail", message: "mkdir failed" };
      }
      return { status: "pass", message: "Directory creation OK" };
    }),
  );

  // Test: List directory (skip if empty - cleanup may have run)
  checks.push(
    check("Filesystem", "listdir", () => {
      const entries = fs.readdirSync(HC_DIR);
      return { status: "pass", message: `Listed ${entries.length} entries` };
    }),
  );

  // Test: Delete file
  checks.push(
    check("Filesystem", "delete", () => {
      const testFile = path.join(HC_DIR, "write-test.txt");
      if (fs.existsSync(testFile)) {
        fs.unlinkSync(testFile);
      }
      if (fs.existsSync(testFile)) {
        return { status: "fail", message: "Delete failed" };
      }
      return { status: "pass", message: "Delete OK" };
    }),
  );

  // Test: Delete directory
  checks.push(
    check("Filesystem", "rmdir", () => {
      const testDir = path.join(HC_DIR, "test-subdir");
      if (fs.existsSync(testDir)) {
        fs.rmSync(testDir, { recursive: true });
      }
      if (fs.existsSync(testDir)) {
        return { status: "fail", message: "rmdir failed" };
      }
      return { status: "pass", message: "Directory removal OK" };
    }),
  );

  // Test: Home directory accessible
  checks.push(
    check("Filesystem", "homedir", () => {
      const home = os.homedir();
      if (!fs.existsSync(home)) {
        return { status: "fail", message: `Home dir not accessible: ${home}` };
      }
      return { status: "pass", message: `Home dir OK: ${home}` };
    }),
  );

  // Test: Temp directory writable
  checks.push(
    check("Filesystem", "tmpdir", () => {
      const tmp = os.tmpdir();
      const testFile = path.join(tmp, `pi-hc-${Date.now()}.tmp`);
      fs.writeFileSync(testFile, "tmp");
      fs.unlinkSync(testFile);
      return { status: "pass", message: `Temp dir OK: ${tmp}` };
    }),
  );

  return checks;
}
