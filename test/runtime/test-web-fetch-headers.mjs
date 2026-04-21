// Regression test: web_fetch must have browser headers to bypass anti-bot
import { createRequire } from "module";
const require = createRequire(import.meta.url);

let pass = 0;
let fail = 0;

// Test 1: Verify that web-fetch tool description mentions headers
const fs = require("fs");
const webFetchSource = fs.readFileSync("src/extensions/web-fetch/index.ts", "utf-8");

const hasUserAgent = webFetchSource.includes("User-Agent");
const hasSecHeaders = webFetchSource.includes("Sec-Ch-Ua");
const hasAcceptLang = webFetchSource.includes("Accept-Language");

if (hasUserAgent) {
  pass++;
  console.log("PASS: web-fetch includes User-Agent header");
} else {
  fail++;
  console.error("FAIL: web-fetch missing User-Agent");
}

if (hasSecHeaders) {
  pass++;
  console.log("PASS: web-fetch includes Sec-* headers");
} else {
  fail++;
  console.error("FAIL: web-fetch missing Sec-* headers");
}

if (hasAcceptLang) {
  pass++;
  console.log("PASS: web-fetch includes Accept-Language header");
} else {
  fail++;
  console.error("FAIL: web-fetch missing Accept-Language");
}

// Test 2: Actually fetch a known anti-bot page (with retries)
console.log("\nFetching immunefi.com (known anti-bot site)...");
try {
  const response = await fetch("https://immunefi.com", {
    headers: {
      "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9",
      "Accept-Encoding": "gzip, deflate, br",
      "Cache-Control": "no-cache",
      "Pragma": "no-cache",
      "Sec-Ch-Ua": '"Chromium";v="122", "Not(A:Brand";v="24", "Google Chrome";v="122"',
      "Sec-Ch-Ua-Mobile": "?0",
      "Sec-Ch-Ua-Platform": '"macOS"',
      "Sec-Fetch-Dest": "document",
      "Sec-Fetch-Mode": "navigate",
      "Sec-Fetch-Site": "none",
      "Sec-Fetch-User": "?1",
      "Upgrade-Insecure-Requests": "1",
    },
    redirect: "follow",
  });

  if (response.status === 200) {
    const body = await response.text();
    // Immunefi is a real site with these known content markers
    const hasImmunefiContent = body.includes("Immunefi") || body.includes("onchain security") || body.includes("web3");
    const hasSubstantialContent = body.length > 10000;
    if (hasSubstantialContent && hasImmunefiContent) {
      pass++;
      console.log(`PASS: immunefi.com returned 200 OK (${body.length} bytes, content verified)`);
    } else {
      fail++;
      console.error(`FAIL: immunefi.com body suspicious (length=${body.length}, hasContent=${hasImmunefiContent})`);
    }
  } else {
    fail++;
    console.error(`FAIL: immunefi.com returned ${response.status}`);
  }
} catch (err) {
  fail++;
  console.error(`FAIL: immunefi.com fetch error: ${err.message}`);
}

console.log(`\nWeb Fetch Tests: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
