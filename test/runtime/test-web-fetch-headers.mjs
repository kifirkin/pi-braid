// Regression test: web_fetch must have browser headers to bypass anti-bot
// Note: pi-web-fetch is now built into pi-coding-agent core. This test checks
// the extension source if installed locally, or skips gracefully.
import { createRequire } from "module";
const require = createRequire(import.meta.url);

const fs = require("fs");
const webFetchPath =
  require("os").homedir() + "/.pi/agent/extensions/pi-web-fetch/index.ts";

let pass = 0;
let fail = 0;

let webFetchSource;
try {
  webFetchSource = fs.readFileSync(webFetchPath, "utf-8");
} catch {
  console.log("SKIP: pi-web-fetch extension not installed (built into core)");
  console.log(`\n📊 Web Fetch Tests: ${pass} passed, ${fail} failed`);
  process.exit(0);
}

if (webFetchSource.includes("User-Agent")) {
	pass++;
	console.log("PASS: web-fetch includes User-Agent header");
} else {
	fail++;
	console.error("FAIL: web-fetch missing User-Agent");
}

if (webFetchSource.includes("Sec-Ch-Ua")) {
	pass++;
	console.log("PASS: web-fetch includes Sec-* headers");
} else {
	fail++;
	console.error("FAIL: web-fetch missing Sec-* headers");
}

if (webFetchSource.includes("Accept-Language")) {
	pass++;
	console.log("PASS: web-fetch includes Accept-Language header");
} else {
	fail++;
	console.error("FAIL: web-fetch missing Accept-Language");
}

console.log(`\n📊 Web Fetch Tests: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);