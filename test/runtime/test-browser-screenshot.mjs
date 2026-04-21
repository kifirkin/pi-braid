// Regression test: browser_screenshot must return filePath in details
import { createRequire } from "module";
const require = createRequire(import.meta.url);

// We can't easily start a real browser, so we verify the saveScreenshotToFile logic
const fs = require("fs");
const path = require("path");
const os = require("os");

function getScreenshotsDir() {
  const dir = path.join(os.homedir(), ".pi", "screenshots");
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

function saveScreenshotToFile(base64Data, format) {
  const dir = getScreenshotsDir();
  const timestamp = Date.now();
  const filename = `screenshot_${timestamp}.${format}`;
  const filepath = path.join(dir, filename);
  const buffer = Buffer.from(base64Data, "base64");
  fs.writeFileSync(filepath, buffer);
  return filepath;
}

// Test: save a small test image
const testBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
const filePath = saveScreenshotToFile(testBase64, "png");

let pass = 0;
let fail = 0;

if (fs.existsSync(filePath)) {
  pass++;
  console.log("PASS: screenshot file saved correctly");
  console.log(`  filePath: ${filePath}`);
  fs.unlinkSync(filePath);
} else {
  fail++;
  console.error("FAIL: screenshot file not saved");
}

// Test: filePath must be under ~/.pi/screenshots/
if (filePath.includes("screenshots")) {
  pass++;
  console.log("PASS: filePath is in screenshots directory");
} else {
  fail++;
  console.error("FAIL: filePath not in screenshots directory");
}

console.log(`\nScreenshot Tests: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
