import fs from 'fs';
import path from 'path';

const BASE = '/Users/kifir/projects/agents/pi-braid/src';
const EXT_DIR = path.join(BASE, 'extensions');

function getImportPath(filePath) {
  const relative = path.relative(path.dirname(filePath), path.join(BASE, 'lib/logger.js'));
  return relative.replace(/\\/g, '/');
}

function getExtName(filePath) {
  const parts = filePath.replace(EXT_DIR + '/', '').split('/');
  return parts[0];
}

function processFile(filePath) {
  let text = fs.readFileSync(filePath, 'utf-8');

  // Skip if already has createLogger or taggedConsole
  if (text.includes('createLogger') || text.includes('taggedConsole')) {
    return { path: filePath, action: 'skipped' };
  }

  const hasConsole = /console\.(log|warn|error|info|debug)/.test(text);
  const extName = getExtName(filePath);
  const importPath = getImportPath(filePath);

  // Add import
  const importLine = `import { createLogger } from "${importPath}";`;

  // Find a good place to insert import (after existing imports, before first non-import)
  const lines = text.split('\n');
  let lastImportIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (trimmed.startsWith('import ') || trimmed.startsWith('//') || trimmed === '') {
      if (trimmed.startsWith('import ')) lastImportIdx = i;
    } else {
      break;
    }
  }

  if (lastImportIdx === -1) {
    // No imports found, prepend
    text = importLine + '\n' + text;
  } else {
    // Insert after last import
    lines.splice(lastImportIdx + 1, 0, importLine);
    text = lines.join('\n');
  }

  // Add logger const after imports
  const loggerLine = `const log = createLogger("${extName}");`;
  const lines2 = text.split('\n');
  let insertAfter = -1;
  for (let i = 0; i < lines2.length; i++) {
    const trimmed = lines2[i].trim();
    if (trimmed.startsWith('import ')) insertAfter = i;
    else if (insertAfter >= 0 && trimmed !== '' && !trimmed.startsWith('//')) break;
  }
  lines2.splice(insertAfter + 1, 0, '', loggerLine);
  text = lines2.join('\n');

  // Replace console.* with log.* if present
  if (hasConsole) {
    text = text.replace(/console\.log\b/g, 'log.info');
    text = text.replace(/console\.warn\b/g, 'log.warn');
    text = text.replace(/console\.error\b/g, 'log.error');
    text = text.replace(/console\.info\b/g, 'log.info');
    text = text.replace(/console\.debug\b/g, 'log.debug');
  }

  fs.writeFileSync(filePath, text, 'utf-8');
  return { path: filePath, action: hasConsole ? 'converted' : 'added' };
}

function walk(dir) {
  const results = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...walk(full));
    } else if (entry.name.endsWith('.ts')) {
      results.push(full);
    }
  }
  return results;
}

const files = walk(EXT_DIR);
const report = [];

for (const f of files) {
  // Skip node_modules
  if (f.includes('node_modules')) continue;
  const res = processFile(f);
  report.push(res);
}

console.log('=== Logging conversion report ===');
const converted = report.filter(r => r.action === 'converted');
const added = report.filter(r => r.action === 'added');
const skipped = report.filter(r => r.action === 'skipped');

console.log(`Converted (had console.*): ${converted.length}`);
converted.forEach(r => console.log('  ' + path.relative(BASE, r.path)));
console.log(`Added (no console.*): ${added.length}`);
added.forEach(r => console.log('  ' + path.relative(BASE, r.path)));
console.log(`Skipped (already has logger): ${skipped.length}`);
skipped.forEach(r => console.log('  ' + path.relative(BASE, r.path)));
