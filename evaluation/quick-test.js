#!/usr/bin/env node
/**
 * Quick Functional Test
 * ======================
 * Minimal test to verify pi-braid extension loads and pi agent responds.
 * Uses a trivial task to measure basic responsiveness.
 */

import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

const PI_BRAID = "/Users/kifir/projects/agents/pi-braid";
const PI_MODEL = process.env.PI_MODEL || "step-3.5-flash-2603";
const PI_PROVIDER = "stepfun";

async function quickTest() {
  console.log("=== Quick Functional Test ===\n");

  const rpc = spawn("pi", [
    "--mode", "rpc",
    "--no-session",
    "--provider", PI_PROVIDER,
    "--model", PI_MODEL,
    "-e", PI_BRAID,
  ], {
    stdio: ["pipe", "pipe", "pipe"],
  });

  const events = [];
  let pendingResolve = null;
  let pendingTimeout = null;

  rpc.stdout.on("data", (chunk) => {
    const lines = chunk.toString().split("\n").filter(Boolean);
    for (const line of lines) {
      try {
        const event = JSON.parse(line);
        if (pendingResolve) {
          const resolve = pendingResolve;
          pendingResolve = null;
          clearTimeout(pendingTimeout);
          resolve(event);
        } else {
          events.push(event);
        }
      } catch {
        // Non-JSON
      }
    }
  });

  const send = (event) => {
    rpc.stdin.write(JSON.stringify(event) + "\n");
  };

  const recvNext = (timeout = 5000) =>
    new Promise((resolve) => {
      pendingResolve = resolve;
      pendingTimeout = setTimeout(() => {
        if (pendingResolve) {
          pendingResolve = null;
          resolve(null);
        }
      }, timeout);
    });

  // Wait for startup
  await sleep(3000);

  // Send a trivial prompt
  console.log("Sending test prompt...");
  send({
    type: "prompt",
    message: "What is 2 + 2? Answer with just the number.",
  });

  let turns = 0;
  let toolCount = 0;
  let textLength = 0;
  let done = false;
  const deadline = Date.now() + 60000;

  while (Date.now() < deadline && !done) {
    const event = await recvNext(8000);
    if (!event) {
      if (rpc.exitCode !== null) break;
      continue;
    }

    const etype = event.type;
    if (etype === "tool_execution_start" || etype === "tool_execution_end") {
      toolCount++;
    }
    if (etype === "message_end") {
      turns++;
      const content = event.message?.content || [];
      for (const block of content) {
        if (block.type === "text") {
          textLength += (block.text || "").length;
        }
      }
    }
    if (etype === "agent_end") {
      done = true;
    }
    if (etype === "extension_ui_request") {
      send({ type: "extension_ui_response", id: event.id, cancelled: true });
    }
  }

  rpc.kill();

  // Report
  console.log("\n--- Results ---");
  console.log(`Turns: ${turns}`);
  console.log(`Tool events: ${toolCount}`);
  console.log(`Text length: ${textLength}`);
  console.log(`Done: ${done ? "YES" : "NO (timeout)"}`);
  console.log(`Extensions loaded: ${events.some((e) => e.type === "extension_loaded") ? "YES" : "checking..."}`);
  console.log(`Event types seen: ${[...new Set(events.map((e) => e.type))].slice(0, 10).join(", ")}`);

  // Check if we got a response
  const lastMessage = events.filter((e) => e.type === "message_end").pop();
  if (lastMessage) {
    const text = (lastMessage.message?.content || [])
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("");
    console.log(`\nResponse preview: "${text.slice(0, 200)}"`);
  }

  return done;
}

quickTest()
  .then((success) => {
    console.log(`\n${success ? "✅ Test PASSED" : "❌ Test FAILED"}`);
    process.exit(success ? 0 : 1);
  })
  .catch((e) => {
    console.error("Error:", e);
    process.exit(1);
  });
