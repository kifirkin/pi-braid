// Test aggregator — runs all runtime test suites
import { execSync } from "child_process";
import { readdirSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));

const files = readdirSync(__dirname)
  .filter((f) => f.endsWith(".mjs") && f !== "test-all.mjs")
  .sort();

let totalPassed = 0;
let totalFailed = 0;

console.log(`Running ${files.length} test suites...\n`);

for (const file of files) {
  const filepath = join(__dirname, file);
  try {
    const output = execSync(`node "${filepath}"`, {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 60000,
    });
    const lines = output.trim().split("\n");
    const resultLine = lines.find((l) => l.includes("passed") && l.includes("failed"));
    if (resultLine) {
      const match = resultLine.match(/(\d+) passed, (\d+) failed/);
      if (match) {
        totalPassed += parseInt(match[1]);
        totalFailed += parseInt(match[2]);
      }
    }
    console.log(`✅ ${file}${resultLine ? " — " + resultLine.trim() : ""}`);
  } catch (err) {
    const stderr = err.stderr?.toString() || "";
    const stdout = err.stdout?.toString() || "";
    const output = stdout + stderr;
    const lines = output.split("\n");
    const resultLine = lines.find((l) => l.includes("passed") && l.includes("failed"));
    if (resultLine) {
      const match = resultLine.match(/(\d+) passed, (\d+) failed/);
      if (match) {
        totalPassed += parseInt(match[1]);
        totalFailed += parseInt(match[2]);
      }
    }
    totalFailed++;
    console.log(`❌ ${file} — FAILED`);
    if (output.length > 0) {
      console.log(output.split("\n").slice(-5).join("\n"));
    }
  }
}

console.log(`\n═══════════════════════════════════════`);
console.log(`TOTAL: ${totalPassed} passed, ${totalFailed} failed`);
console.log(`═══════════════════════════════════════`);

if (totalFailed > 0) process.exit(1);
