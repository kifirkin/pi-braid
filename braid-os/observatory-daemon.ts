/**
 * Observatory Daemon — singleton process that runs the WebSocket server
 * for the three.js monitoring dashboard.
 *
 * This is the SINGLE daemon process that binds port 4199.
 * Pi instances connect to it via IPC (Unix socket) to push metrics.
 *
 * Managed by braid-daemon.sh. Started once, runs persistently.
 * If it crashes, braid-daemon.sh restarts it automatically.
 */

import * as fs from "node:fs";
import * as http from "node:http";
import {
  startObservatory,
  stopObservatory,
  getObservatoryStatus,
} from "../dist/lib/observatory.js";

const PORT = parseInt(process.env.OBSERVATORY_PORT || "4199", 10);
const HOST = process.env.OBSERVATORY_HOST || "localhost";

// ── Startup ────────────────────────────────────────────────────────────

console.log(`[observatory-daemon] Starting observatory on ${HOST}:${PORT}...`);

try {
  startObservatory({ port: PORT, host: HOST });
  console.log(`[observatory-daemon] Observatory running on ws://${HOST}:${PORT}`);
  console.log(`[observatory-daemon] PID: ${process.pid}`);

  // ── Signal handling ─────────────────────────────────────────────────
  const shutdown = () => {
    console.log("\n[observatory-daemon] Shutting down...");
    stopObservatory();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // ── Health check HTTP endpoint ──────────────────────────────────────
  const healthServer = http.createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end(getObservatoryStatus());
  });

  healthServer.listen(0, "127.0.0.1", () => {
    const addr = healthServer.address();
    const healthPort = typeof addr === "object" && addr ? addr.port : 0;
    console.log(`[observatory-daemon] Health check on 127.0.0.1:${healthPort}`);

    // Write health port to a temp file so daemon script can read it
    const pidDir = process.env.HOME ? `${process.env.HOME}/.pi-braid` : "/tmp/.pi-braid";
    fs.mkdirSync(pidDir, { recursive: true });
    fs.writeFileSync(
      `${pidDir}/observatory.health`,
      JSON.stringify({ pid: process.pid, port: PORT, healthPort, host: HOST }),
    );
  });

  // ── Keep alive ──────────────────────────────────────────────────────
  setInterval(() => {
    // Heartbeat — keep process alive, prevent idle exit
  }, 60_000).unref();
} catch (err) {
  console.error(`[observatory-daemon] Failed to start: ${err}`);
  process.exit(1);
}
