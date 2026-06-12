/**
 * Evaluator - shared benchmark runner for pi-braid.
 *
 * Pure JS (.mjs), no TS syntax. Works in any Node >= 18.
 *
 * Usage:
 *   import { createBenchSession, runTask, verifyBuild } from './lib/evaluator.mjs';
 *   const { session, cleanup } = await createBenchSession({ safeMode: true });
 *   const result = await runTask({ session, task: { id: 'test', prompt: '...', timeout: 60 } });
 *   cleanup();
 */

import { execSync } from 'child_process';
import { existsSync, mkdirSync, writeFileSync, readFileSync, rmSync, statSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');

// ── Build verification ────────────────────────────────────────────────────

/**
 * Ensure dist/ is built before running benchmarks.
 * Call once at the top of any benchmark entry point.
 */
export function verifyBuild() {
  const distDir = join(ROOT, 'dist');
  if (!existsSync(distDir)) {
    console.error('[evaluator] dist/ missing - running npm build...');
    execSync('npm run build', { cwd: ROOT, stdio: 'inherit', timeout: 120000 });
  }
  const required = ['dist/lib/tool-security.js'];
  for (const f of required) {
    if (!existsSync(join(ROOT, f))) {
      throw new Error(`Build incomplete: missing ${f}. Run 'npm run build'`);
    }
  }
}

// ── Provider helpers ──────────────────────────────────────────────────────

/**
 * Resolve the stepfun provider extension file path.
 */
export function resolveStepfunProvider() {
  const paths = [
    '/Users/kifir/projects/agents/pi-poorman-providers/stepfun.ts',
    join(ROOT, '..', 'pi-poorman-providers', 'stepfun.ts'),
  ];
  for (const p of paths) {
    if (existsSync(p)) return p;
  }
  throw new Error(
    'Cannot find stepfun provider. Expected at:\n' + paths.join('\n') +
    '\nSet PI_PROVIDER_PATH env var to override.'
  );
}

/**
 * Get the default stepfun model config.
 */
export function getStepfunModel() {
  return {
    id: 'step-3.5-flash',
    provider: 'stepfun',
    api: 'openai-completions',
    baseUrl: 'https://api.stepfun.ai/step_plan/v1',
  };
}

// ── Session factory ───────────────────────────────────────────────────────

/**
 * Create a benchmark agent session with all shared setup.
 *
 * @param {object} opts
 * @param {object}  opts.model       - Model config (defaults to step-3.5-flash)
 * @param {string}  opts.sessionDir  - Session directory (default: /tmp/pi-bench-*)
 * @param {boolean} opts.safeMode    - Enable safe mode (restricts bash)
 * @param {boolean} opts.compaction  - Enable compaction (default: false)
 * @returns {{ session: object, cleanup: Function }}
 */
export async function createBenchSession(opts = {}) {
  const {
    createAgentSession, SessionManager, SettingsManager,
    DefaultResourceLoader, getAgentDir
  } = await import('@mariozechner/pi-coding-agent');

  const stepfunPath = resolveStepfunProvider();
  const model = opts.model || getStepfunModel();
  const sessionDir = opts.sessionDir || `/tmp/pi-bench-${Date.now()}`;
  mkdirSync(sessionDir, { recursive: true });

  const stepfunMod = await import(stepfunPath);

  const loader = new DefaultResourceLoader({
    cwd: '/tmp',
    agentDir: getAgentDir(),
    extensionFactories: [(pi) => {
      pi.registerProvider('stepfun', {
        baseUrl: 'https://api.stepfun.ai/step_plan/v1',
        apiKey: 'STEP_API_KEY',
        api: 'openai-completions',
        models: stepfunMod.stepfunModels,
      });
    }],
  });
  await loader.reload();

  const { session } = await createAgentSession({
    resourceLoader: loader,
    model,
    sessionManager: SessionManager.inMemory(),
    settingsManager: SettingsManager.inMemory({
      compaction: { enabled: opts.compaction ?? false },
    }),
  });

  // Apply tool security
  if (opts.safeMode) {
    const { restrictTools } = await import(join(ROOT, 'dist', 'lib', 'tool-security.js'));
    restrictTools(session);
  }

  return {
    session,
    cleanup: () => {
      try { session.dispose(); } catch {}
    },
  };
}

// ── Task runner ───────────────────────────────────────────────────────────

/**
 * Run a single benchmark task.
 *
 * @param {object} session   - Agent session (from createBenchSession)
 * @param {object} task
 * @param {string} task.id   - Task identifier
 * @param {string} task.prompt - User message to send
 * @param {number} task.timeout - Max seconds
 * @returns {object} { taskId, duration (ms), turns, error, toolsUsed, text }
 */
export async function runTask(session, task) {
  const result = {
    taskId: task.id,
    duration: 0,
    turns: 0,
    error: null,
    toolsUsed: [],
    text: '',
  };

  const tools = new Set();
  const unsub = session.subscribe((evt) => {
    if (evt.type === 'turn_start') result.turns++;
    if (evt.type === 'tool_execution_start') tools.add(evt.toolName);
    if (evt.type === 'message_end' && evt.message?.role === 'assistant') {
      for (const b of (evt.message.content || [])) {
        if (b.type === 'text') result.text += b.text;
      }
    }
  });

  const start = Date.now();
  try {
    await Promise.race([
      session.prompt(task.prompt),
      new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), (task.timeout || 60) * 1000)),
    ]);
  } catch (err) {
    result.error = err.message || String(err);
    // Abort any in-flight session operation to reset state for next task
    try { await session.agent?.waitForIdle(); } catch {}
  }
  result.duration = Date.now() - start;
  result.toolsUsed = [...tools];

  unsub();
  return result;
}

// ── Clean room check ──────────────────────────────────────────────────────

/**
 * Check for stale temp benchmark directories (older than 1 hour).
 */
export function checkStaleDirs() {
  const issues = [];
  try {
    const entries = readdirSync('/tmp');
    const now = Date.now();
    for (const entry of entries) {
      if (entry.startsWith('pi-bench-') || entry.startsWith('pi-stress-') || entry.startsWith('bm2-')) {
        const fullPath = join('/tmp', entry);
        try {
          const st = statSync(fullPath);
          if (now - st.mtimeMs > 3600000) {
            issues.push(`Stale: ${fullPath}`);
          }
        } catch {}
      }
    }
  } catch {}
  return issues;
}

// ── Result formatting ─────────────────────────────────────────────────────

/**
 * Format results as a markdown table.
 */
export function formatResultsTable(results) {
  const header = '| Task | Duration | Turns | Tools | Error |';
  const sep = '|------|----------|-------|-------|-------|';
  const rows = results.map(r => {
    const tools = r.toolsUsed.length > 3
      ? r.toolsUsed.slice(0, 3).join(',') + '...'
      : r.toolsUsed.join(',');
    const error = r.error ? `✗ ${r.error.slice(0, 30)}` : '✓';
    const dur = (r.duration / 1000).toFixed(1);
    return `| ${r.taskId} | ${dur}s | ${r.turns} | ${tools || '-'} | ${error} |`;
  });
  return [header, sep, ...rows].join('\n');
}
