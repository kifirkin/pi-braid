#!/usr/bin/env node
/**
 * Autonomous Compaction Stress Test v3
 *
 * Single long session → explicit compaction → post-compaction bash.
 * Verifies the BashExecutionMessage bug fix at every step.
 */

import { createAgentSession, SessionManager, SettingsManager, DefaultResourceLoader, getAgentDir } from '@mariozechner/pi-coding-agent';
import { stepfunModels } from '/Users/kifir/projects/agents/pi-poorman-providers/stepfun.ts';
import { readFileSync, mkdirSync } from 'fs';
import { join } from 'path';

const TMP = '/tmp/pi-stress-v3';
const SESSION_DIR = join(TMP, 'sessions');
mkdirSync(SESSION_DIR, { recursive: true });

const model = {
  ...stepfunModels.find(m => m.id === 'step-3.5-flash'),
  provider: 'stepfun',
  api: 'openai-completions',
  baseUrl: 'https://api.stepfun.ai/step_plan/v1',
};

function createLoader() {
  return new DefaultResourceLoader({
    cwd: TMP,
    agentDir: getAgentDir(),
    extensionFactories: [(pi) => {
      pi.registerProvider('stepfun', {
        baseUrl: 'https://api.stepfun.ai/step_plan/v1',
        apiKey: 'STEP_API_KEY',
        api: 'openai-completions',
        models: stepfunModels,
      });
    }],
  });
}

const PROMPTS = [
  'Run the bash command: ls -la /tmp. Report how many files there are.',
  'Run the bash command: whoami. Report the output.',
  'Write /tmp/stress-v3/hello.js that prints "Hello". Then run: node /tmp/stress-v3/hello.js',
  'Write a debounce function to /tmp/stress-v3/debounce.js with module.exports.',
  'Run the bash command: echo hello | wc -c. Report the character count.',
  'Write an EventEmitter to /tmp/stress-v3/emitter.js with on/emit/off/once.',
  'Run the bash command: date +%Y-%m-%d. Report the result.',
  'Write a deepClone to /tmp/stress-v3/deepClone.js with circular ref handling.',
  'Run the bash command: echo $SHELL. Report the shell path.',
  'Run the bash command: pwd. Report the current directory.',
];

const POST_COMPACT = [
  'Run the bash command: echo "post-compaction-verified". Report the output.',
  'Read /tmp/stress-v3/debounce.js and summarize it in one line.',
  'Write /tmp/stress-v3/post-check.txt containing the text "compaction passed".',
  'Run the bash command: cat /tmp/stress-v3/post-check.txt. Report what it says.',
];

function verifyIntegrity(sessionFile, prevCount) {
  try {
    const content = readFileSync(sessionFile, 'utf-8');
    const lines = content.trim().split('\n').filter(l => l.trim());
    let bashCount = 0, writeCount = 0, userCount = 0, assistantCount = 0, toolCount = 0, compactCount = 0;
    const issues = [];

    for (const line of lines) {
      try {
        const e = JSON.parse(line);
        if (e.type === 'message' && e.message) {
          const m = e.message;
          if (m.role === 'user') userCount++;
          else if (m.role === 'assistant') {
            assistantCount++;
            if (Array.isArray(m.content)) {
              for (const b of m.content) {
                if (b.type === 'toolCall' && b.name === 'write') writeCount++;
              }
            }
          } else if (m.role === 'toolResult') toolCount++;
          else if (m.role === 'bashExecution') {
            bashCount++;
            if (!m.command && !m.output) issues.push('bashExecution missing cmd/output');
          }
        } else if (e.type === 'compaction') {
          compactCount++;
        }
      } catch {}
    }

    return { ok: issues.length === 0, total: lines.length, new: lines.length - prevCount, bash: bashCount, write: writeCount, user: userCount, assistant: assistantCount, tool: toolCount, compact: compactCount, issues };
  } catch (err) {
    return { ok: false, total: 0, new: 0, bash: 0, write: 0, user: 0, assistant: 0, tool: 0, compact: 0, issues: [err.message] };
  }
}

async function runPrompts(session, prompts, label, sessionFile, prevEntryCount) {
  for (let i = 0; i < prompts.length; i++) {
    const p = prompts[i];
    process.stdout.write(`[${label} ${i + 1}/${prompts.length}] ${p.slice(0, 60)}... `);
    try { await session.agent?.waitForIdle(); } catch {}
    await new Promise(r => setTimeout(r, 300));
    try {
      await Promise.race([
        session.prompt(p, { streamingBehavior: 'followUp' }),
        new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 120000)),
      ]);
    } catch (err) {
      console.log(`ERR: ${(err.message || err).slice(0, 60)}`);
      continue;
    }
    const v = verifyIntegrity(sessionFile, prevEntryCount);
    prevEntryCount = v.total;
    if (v.ok) {
      console.log(`✓ b=${v.bash} w=${v.write} t=${v.tool} total=${v.total}`);
    } else {
      console.log(`✗ ${v.issues.join('; ')}`);
    }
    if (v.compact > 0) console.log('  └─ COMPACTION TRIGGERED!');
  }
  return prevEntryCount;
}

async function main() {
  console.log('=== pi-braid Compaction Stress Test v3 ===\n');

  const sm = SessionManager.create(TMP, SESSION_DIR);
  const loader = createLoader();
  await loader.reload();

  const { session } = await createAgentSession({
    resourceLoader: loader, model, sessionManager: sm,
    settingsManager: SettingsManager.inMemory({
      compaction: { enabled: true, reserveTokens: 4096, keepRecentTokens: 2048 },
    }),
  });

  const sessionFile = sm.getSessionFile();
  console.log(`Session: ${sessionFile}\n`);

  // Phase 1: Normal prompts
  let entryCount = await runPrompts(session, PROMPTS, 'PRE', sessionFile, 0);

  // Phase 2: Explicit compaction
  console.log('\n--- Compaction ---');
  try {
    const r = await session.compact();
    console.log('  Result:', JSON.stringify(r).slice(0, 120));
  } catch (err) {
    console.log('  Error:', err.message);
  }

  // Phase 3: Post-compaction prompts (bash must survive)
  entryCount = await runPrompts(session, POST_COMPACT, 'POST', sessionFile, entryCount);

  await session.dispose();

  // Final integrity report
  console.log('\n' + '='.repeat(50));
  console.log('FINAL REPORT');
  console.log('='.repeat(50));
  const final = verifyIntegrity(sessionFile, 0);
  console.log(`Entries: ${final.total}`);
  console.log(`Bash: ${final.bash} | Write: ${final.write} | Tool: ${final.tool} | Compact: ${final.compact}`);
  if (final.issues.length > 0) {
    console.log(`\nISSUES:`);
    final.issues.forEach(i => console.log(`  - ${i}`));
  } else {
    console.log(`\n✓ ZERO issues`);
  }

  // Critical: verify bash survived compaction
  if (final.compact > 0 && final.bash > 0) {
    console.log('✓ Bash messages SURVIVED compaction - bug fix verified');
  }

  process.exit(final.issues.length > 0 ? 1 : 0);
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
