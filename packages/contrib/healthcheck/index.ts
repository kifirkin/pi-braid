import * as path from "node:path";
import * as fs from "node:fs";
import { createLogger } from "../logger.js";
import { healthcheckDir } from "pi-braid/lib";
import { Type } from "typebox";
import type {
  AgentToolResult,
  ExtensionAPI,
} from "@earendil-works/pi-coding-agent";

import type { HealthReport } from "./checks/types.js";
import { cleanupHcDir, ensureHcDir } from "./checks/helpers.js";
import { testFilesystem } from "./checks/filesystem.js";
import { testPathOperations } from "./checks/paths.js";
import { testBashShell } from "./checks/shell.js";
import { testMemoryAndState } from "./checks/state.js";
import { testSystemResources } from "./checks/resources.js";
import { testAgentConfiguration } from "./checks/agent.js";
import { testAgentTools } from "./checks/tools.js";
import { testBuiltinTools } from "./checks/builtin.js";
import { testExtensionSystem } from "./checks/extensions.js";
import { generateReport, formatReport } from "./checks/report.js";

const log = createLogger("healthcheck");

/**
 * Healthcheck Extension - Validate agent readiness
 *
 * Provides a `healthcheck` tool that tests:
 * - Filesystem operations (via Node.js fs module)
 * - Shell tools (echo, node, git, npm, grep)
 * - Agent tools (bash, read, write, edit, grep, find, ls)
 * - Builtin tools (plan, goals, think, etc.)
 * - Extension system (loaded extensions)
 * - Agent configuration (core types and hooks)
 * - System resources (memory, CPU, disk)
 *
 * Storage: probe scratch files and the saved report under the live braid
 * home's healthcheck dir (`healthcheckDir()`; BRAID_HOME is honored).
 */

const healthcheckSchema = Type.Object({
  verbose: Type.Optional(
    Type.Boolean({ default: false, description: "Include detailed output" }),
  ),
  categories: Type.Optional(
    Type.Array(Type.String(), {
      description:
        "Categories to test: filesystem, paths, shell, state, resources, agent, tools, builtin, extensions. Default: all",
    }),
  ),
});

export default function healthcheckExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: "healthcheck",
    exposure: "deferred",
    label: "Healthcheck",
    promptSnippet:
      "Run health check on tools, extensions, and system resources",
    description:
      "Run a comprehensive health check on tools, extensions, and system resources. " +
      "Tests tool registry, built-in tools, extension API, shell commands, and system capabilities. " +
      "Returns pass/fail/warn status with recommendations.",
    parameters: healthcheckSchema,
    execute: async (
      _toolCallId,
      params,
    ): Promise<AgentToolResult<HealthReport>> => {
      const requestedCats = params.categories;
      const shouldRun = (cat: string) =>
        !requestedCats || requestedCats.includes(cat.toLowerCase());

      // The probe scratch dir exists before any category runs: the tools
      // probes use it as their cwd, and the report lands in it below. A
      // refused root (no absolute braid home) leaves it absent: the probes
      // that need it report their own failure and the report write warns.
      try {
        ensureHcDir();
      } catch (err) {
        log.warn(`healthcheck scratch dir unavailable: ${err}`);
      }

      const allChecks: import("./checks/types.js").CheckResult[] = [];

      if (shouldRun("filesystem")) {
        allChecks.push(...testFilesystem());
      }
      if (shouldRun("paths")) {
        allChecks.push(...testPathOperations());
      }
      if (shouldRun("shell")) {
        allChecks.push(...testBashShell());
      }
      if (shouldRun("state")) {
        allChecks.push(...testMemoryAndState());
      }
      if (shouldRun("resources")) {
        allChecks.push(...testSystemResources());
      }
      if (shouldRun("agent")) {
        allChecks.push(...testAgentConfiguration());
      }
      if (shouldRun("tools")) {
        allChecks.push(...testAgentTools(pi));
      }
      if (shouldRun("builtin")) {
        allChecks.push(...testBuiltinTools(pi));
      }
      if (shouldRun("extensions")) {
        allChecks.push(...testExtensionSystem(pi));
      }

      // Cleanup
      cleanupHcDir();

      const report = generateReport(allChecks);
      const text = formatReport(report);

      try {
        const reportFile = path.join(
          healthcheckDir(),
          `report-${Date.now()}.json`,
        );
        fs.writeFileSync(reportFile, JSON.stringify(report, null, 2));
      } catch (e) {
        log.warn(`Could not save healthcheck report: ${e}`);
      }

      return {
        content: [{ type: "text" as const, text }],
        details: report,
      };
    },
  });

  log.info("Healthcheck extension registered (modular).");
  return {
    name: "healthcheck",
    version: "3.0.0",
  };
}
