#!/usr/bin/env node
/**
 * pi-braid vs Naked pi — Wrapper that runs existing SDK benchmarks with
 * a different loader config for the naked baseline.
 *
 * For each benchmark, it replaces the DefaultResourceLoader cwd so
 * no braid extensions are loaded (only stepfun provider).
 */

const BENCHMARKS = ['bm1-sdk', 'bm2-sdk', 'br1-sdk'];

async function runBenchmark(name, isBraid) {
  const label = isBraid ? 'braid' : 'naked';
  console.log(`\n=== ${name} [${label}] ===`);

  const mod = await import(`./${name}.mjs`);
  const filePath = `/tmp/${name}-${label}-output.txt`;

  // We can't easily change the loader config in the imported module.
  // Instead, we monkey-patch the DefaultResourceLoader behavior.
  // But that's fragile. Better approach: run the benchmark file as a subprocess
  // with an environment variable indicating braid/naked mode.
  
  // Actually, the simplest approach: copy the benchmark file, modify the cwd,
  // and run it as a separate process.
}

// Alternative: run via CLI subprocess
// `pi -ne -e /path/to/providers` would give us naked pi
// But the SDK benchmarks use createAgentSession, not the CLI.

// Best approach: the benchmarks read their EXTENSIONS_PATH from env or args.
// Let me create modified versions that accept --naked flag.

console.log('=== pi-braid vs Naked pi Comparison ===');
console.log('\nRunning benchmarks via subprocess with config flag...\n');

const results = [];

for (const name of BENCHMARKS) {
  for (const isBraid of [true, false]) {
    const label = isBraid ? 'braid' : 'naked';
    const outputFile = `/tmp/bench-${name}-${label}.json`;

    // The benchmark modules read PI_EXTENSIONS env var.
    // Set it to empty for naked, to braid path for braid mode.
    const env = {
      ...process.env,
      PI_EXTENSIONS: isBraid ? '/Users/kifir/projects/agents/pi-braid' : '',
      PI_MODEL: 'step-3.5-flash',
      PI_PROVIDER: 'stepfun',
    };

    const { execSync } = await import('child_process');
    const start = Date.now();
    try {
      const stdout = execSync(`node evaluation/${name}.mjs --timeout 60`, {
        env,
        timeout: 120000,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      
      // Extract overall score from output
      const overallMatch = stdout.match(/Overall:\s*([\d.]+)\/100/);
      const score = overallMatch ? parseFloat(overallMatch[1]) : null;
      const duration = ((Date.now() - start) / 1000).toFixed(1);
      
      console.log(`  ${name} [${label}]: score=${score ?? 'N/A'}, ${duration}s`);
      results.push({ name, label, score, duration });
    } catch (err) {
      const duration = ((Date.now() - start) / 1000).toFixed(1);
      const output = err.stdout || '';
      const overallMatch = output.match(/Overall:\s*([\d.]+)\/100/);
      const score = overallMatch ? parseFloat(overallMatch[1]) : 'error';
      console.log(`  ${name} [${label}]: score=${score}, ${duration}s (${err.message.slice(0, 40)})`);
      results.push({ name, label, score, duration });
    }
  }
}

// ── Table ──────────────────────────────────────────────────────────────────
console.log('\n' + '='.repeat(60));
console.log('RESULTS');
console.log('='.repeat(60));
console.log('\n| Benchmark | Config | Score | Duration |');
console.log('|-----------|--------|-------|----------|');

const grouped = {};
for (const r of results) {
  if (!grouped[r.name]) grouped[r.name] = {};
  grouped[r.name][r.label] = r;
}

for (const [name, configs] of Object.entries(grouped)) {
  const b = configs.braid;
  const n = configs.naked;
  const bScore = b?.score ?? '?';
  const nScore = n?.score ?? '?';
  const bDur = b?.duration ?? '?';
  const nDur = n?.duration ?? '?';
  console.log(`| ${name} | braid | ${bScore}/100 | ${bDur}s |`);
  console.log(`| | naked | ${nScore}/100 | ${nDur}s |`);
  if (typeof bScore === 'number' && typeof nScore === 'number') {
    const delta = bScore - nScore;
    console.log(`| | **Delta** | **${delta >= 0 ? '+' : ''}${delta}** | — |`);
  }
}

const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
const { writeFileSync } = await import('fs');
const mdPath = `/Users/kifir/projects/agents/pi-braid/evaluation/results/comparison_${timestamp}.md`;
let md = `# pi-braid vs Naked pi — Comparison Results\n\n`;
md += `**Generated**: ${new Date().toISOString()}\n`;
md += `**Model**: stepfun/step-3.5-flash\n\n`;
md += `| Benchmark | Config | Score | Duration |\n`;
md += `|-----------|--------|-------|----------|\n`;
for (const [name, configs] of Object.entries(grouped)) {
  const b = configs.braid;
  const n = configs.naked;
  md += `| ${name} | braid | ${b?.score ?? '?'}/100 | ${b?.duration ?? '?'}s |\n`;
  md += `| | naked | ${n?.score ?? '?'}/100 | ${n?.duration ?? '?'}s |\n`;
  if (typeof b?.score === 'number' && typeof n?.score === 'number') {
    md += `| | **Delta** | **${b.score - n.score >= 0 ? '+' : ''}${b.score - n.score}** | — |\n`;
  }
}
writeFileSync(mdPath, md);
console.log(`\nResults saved to ${mdPath}`);
