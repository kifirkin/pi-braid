/**
 * Anti-Slop Extension for Braid
 * 
 * Provides slop pattern detection and correction functionality.
 * Main logic is wired into user-message-preprocessor.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

// Response patterns for slop detection
const RESPONSE_SLOP_PATTERNS = [
  {
    name: "circular_shared",
    pattern: /(?:the user (?:has )?shared|you('ve| have)? shared|shared (?:a )?(?:javascript|function|code))/i,
    weight: 20,
    action: "extract_code" as const,
  },
  {
    name: "asks_clarification",
    pattern: /(?:what would you(?: like)?|would you like|let me know|feel free to|please tell)/i,
    weight: 15,
    action: "retry" as const,
  },
  {
    name: "analysis_mode",
    pattern: /(?:analyz|examin|review|look at|inspect)/i,
    weight: 8,
    action: "extract_code" as const,
  },
  {
    name: "this_is_explanation",
    pattern: /^this is (?:a|an|your|the)/i,
    weight: 6,
    action: "extract_code" as const,
  },
  {
    name: "how_it_works",
    pattern: /(?:how it works|here('s| is) how|it works by)/i,
    weight: 5,
    action: "extract_code" as const,
  },
  {
    name: "what_next",
    pattern: /(?:what would you(?: like to)?(?: do| know)|want me to|i can help with)/i,
    weight: 8,
    action: "retry" as const,
  },
  {
    name: "print_statements",
    pattern: /(?:print\(|console\.log)/i,
    weight: 3,
    action: "extract_code" as const,
  },
];

export interface SlopScore {
  score: number;
  hardFails: string[];
  actions: ("extract_code" | "retry")[];
  hasFunction: boolean;
  hasCodeBlock: boolean;
  hasPrintStatements: boolean;
  wordCount: number;
  verdict: "good" | "slop" | "critical";
}

export function scoreResponse(response: string): SlopScore {
  const hardFails: string[] = [];
  const actions: ("extract_code" | "retry")[] = [];
  
  const hasFunction = /(?:def\s+\w+|function\s+\w+|class\s+\w+)/.test(response);
  const hasCodeBlock = /```[\s\S]*?```/.test(response);
  const hasPrintStatements = /(?:print\(|console\.log)/.test(response);
  
  const textWithoutCode = response.replace(/```[\s\S]*?```/g, '');
  const wordCount = textWithoutCode.split(/\s+/).filter(w => w.length > 0).length;
  
  let score = 0;
  for (const p of RESPONSE_SLOP_PATTERNS) {
    const matches = response.match(p.pattern);
    if (matches) {
      score += p.weight * matches.length;
      if (p.weight >= 15) hardFails.push(p.name);
      if (!actions.includes(p.action)) actions.push(p.action);
    }
  }
  
  if (!hasFunction && !hasCodeBlock && wordCount > 50) {
    score += 15;
    hardFails.push("missing_function");
    actions.push("retry");
  }
  
  if (wordCount > 300 && !hasCodeBlock) {
    score += 5;
  }
  
  const verdict: "good" | "slop" | "critical" = 
    hardFails.length > 0 || score > 20 ? "critical" :
    score > 10 || wordCount > 200 ? "slop" : "good";
  
  return { score, hardFails, actions, hasFunction, hasCodeBlock, hasPrintStatements, wordCount, verdict };
}

export function extractCode(response: string): string | null {
  const codeBlockMatch = response.match(/```[\s\S]*?```/);
  if (codeBlockMatch) {
    const content = codeBlockMatch[0];
    if (/(?:def\s+\w+|function\s+\w+|class\s+\w+)/.test(content)) {
      return content;
    }
  }
  
  const funcMatch = response.match(
    /(?:function\s+\w+|def\s+\w+|const\s+\w+\s*=\s*(?:async\s+)?(?:(?:\([^)]*\)|[^\s{])\s*)?(?:=>)?|class\s+\w+)[\s\S]{10,500}/i
  );
  if (funcMatch) {
    return "```\n" + funcMatch[0].trim() + "\n```";
  }
  
  return null;
}

export interface ProcessResult {
  response: string;
  transformed: boolean;
  action: "none" | "extract_code" | "retry";
  reason: string;
}

export function processResponse(response: string, isCodeRequest: boolean = true): ProcessResult {
  const score = scoreResponse(response);
  
  if (score.verdict === "good") {
    return { response, transformed: false, action: "none", reason: "acceptable" };
  }
  
  if (score.actions.includes("extract_code") || (isCodeRequest && !score.hasFunction)) {
    const extracted = extractCode(response);
    if (extracted) {
      return { 
        response: extracted, 
        transformed: true, 
        action: "extract_code", 
        reason: `extracted_from_${score.hardFails[0] || "slop"}` 
      };
    }
  }
  
  if (score.verdict === "critical" && score.actions.includes("retry")) {
    return { 
      response, 
      transformed: false, 
      action: "retry", 
      reason: `critical_${score.hardFails.join("_")}` 
    };
  }
  
  return { response, transformed: false, action: "none", reason: "transformation_failed" };
}

export default function antiSlopExtension(pi: ExtensionAPI) {
  const state = {
    enabled: true,
    stats: {
      promptsProcessed: 0,
      correctionsInjected: 0,
      responsesProcessed: 0,
      extractions: 0,
      retries: 0,
    },
  };
  
  pi.on("input", async (event, _ctx) => {
    if (!state.enabled) return;
    const prompt = event.text?.trim() || "";
    if (!prompt) return;
    state.stats.promptsProcessed++;
  });
  
  pi.registerCommand("anti-slop", {
    description: "Toggle anti-slop enforcement",
    handler: async (_args, ctx) => {
      state.enabled = !state.enabled;
      ctx.ui.notify(`Anti-slop ${state.enabled ? "enabled" : "disabled"}`, "info");
    },
  });
  
  pi.registerCommand("anti-slop-stats", {
    description: "Show anti-slop statistics",
    handler: async (_args, ctx) => {
      const s = state.stats;
      ctx.ui.notify(
        `Anti-slop: ${s.promptsProcessed} prompts, ${s.correctionsInjected} corrections, ${s.extractions} extractions`,
        "info"
      );
    },
  });
  
  console.log("[anti-slop] Extension registered");
}