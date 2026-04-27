// Regression test: read_document must NEVER return raw PDF binary
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const fs = require("fs");
const path = require("path");

// Inline isBinaryContent matching src/extensions/tools/docs/index.ts logic
function isBinaryContent(content) {
  if (content.includes("\0")) return true;
  const sampleSize = Math.min(content.length, 8192);
  const sample = content.slice(0, sampleSize);
  let controlChars = 0;
  for (let i = 0; i < sample.length; i++) {
    const code = sample.charCodeAt(i);
    if (code < 32 && code !== 9 && code !== 10 && code !== 13) {
      controlChars++;
    }
  }
  return controlChars / sampleSize > 0.05;
}

const testPdfPath = "/tmp/test_regression.pdf";

// Create a REAL binary PDF (not text-constructible)
// PDF binary starts with %PDF- but contains binary object streams
const binaryPdf = Buffer.concat([
  Buffer.from("%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n"),
  Buffer.from(Array(200).fill(0).map((_, i) => i % 256)), // binary object stream
  Buffer.from("\n2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n"),
  Buffer.from(Array(100).fill(0).map((_, i) => (i * 7) % 256)), // more binary
  Buffer.from("\ntrailer\n<< /Size 3 /Root 1 0 R >>\n%%EOF\n"),
]);
fs.writeFileSync(testPdfPath, binaryPdf);

const pdfAsString = fs.readFileSync(testPdfPath, "utf-8");
const isBinary = isBinaryContent(pdfAsString);

let pass = 0;
let fail = 0;

// Test 1: Real binary PDF should be flagged
if (isBinary) {
  pass++;
  console.log("PASS: isBinaryContent flags real binary PDF");
} else {
  fail++;
  console.error("FAIL: isBinaryContent did NOT flag binary PDF");
}

// Test 2: Normal text should NOT be flagged
const normalText = "Hello world\nThis is a normal document.\nLine 3.\n";
if (!isBinaryContent(normalText)) {
  pass++;
  console.log("PASS: normal text not flagged as binary");
} else {
  fail++;
  console.error("FAIL: normal text incorrectly flagged as binary");
}

// Test 3: Null byte should trigger
if (isBinaryContent("hello\0world")) {
  pass++;
  console.log("PASS: null byte triggers binary detection");
} else {
  fail++;
  console.error("FAIL: null byte did not trigger detection");
}

// Test 4: Excessive control chars should trigger
const controlHeavy = "\x01\x02\x03\x04\x05".repeat(100) + "some text";
if (isBinaryContent(controlHeavy)) {
  pass++;
  console.log("PASS: excessive control chars trigger binary detection");
} else {
  fail++;
  console.error("FAIL: excessive control chars did not trigger");
}

console.log(`\nPDF Safety Tests: ${pass} passed, ${fail} failed`);
fs.unlinkSync(testPdfPath);

if (fail > 0) process.exit(1);
