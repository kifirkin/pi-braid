// Regression test: web_fetch must have browser headers to bypass anti-bot
import { createRequire } from "module";
const require = createRequire(import.meta.url);

const fs = require("fs");
const webFetchSource = fs.readFileSync(
  require("os").homedir() + "/.pi/agent/extensions/pi-web-fetch/index.ts",
  "utf-8"
);

let pass = 0;
let fail = 0;

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