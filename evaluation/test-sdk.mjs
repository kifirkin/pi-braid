#!/usr/bin/env node
/**
 * Quick test: verify SDK + stepfun model works
 */
import { createAgentSession, SessionManager, SettingsManager } from '@mariozechner/pi-coding-agent';

async function main() {
  const { session } = await createAgentSession({
    cwd: '/Users/kifir/projects/agents/pi-braid',
    sessionManager: SessionManager.inMemory(),
    settingsManager: SettingsManager.inMemory({ compaction: { enabled: false } }),
  });

  console.log('Default model:', session.model?.id, '| provider:', session.model?.provider);

  // Try to set stepfun model
  try {
    await session.setModel({ provider: 'stepfun', id: 'step-3.5-flash' });
    console.log('setModel to stepfun: SUCCESS, model:', session.model?.id);
  } catch (e) {
    console.log('setModel to stepfun: FAILED —', e.message?.slice(0, 100));
  }

  // Test a simple prompt
  let text = '';
  session.subscribe((evt) => {
    if (evt.type === 'message_update' && evt.assistantMessageEvent.type === 'text_delta') {
      text += evt.assistantMessageEvent.delta;
    }
  });

  console.log('\nRunning prompt with stepfun...');
  try {
    await session.prompt('Say hello in exactly 3 words.');
    console.log('Result:', text.slice(0, 80));
  } catch (e) {
    console.log('Prompt error:', e.message?.slice(0, 100));
  }
}

main().catch((err) => {
  console.error('Error:', err);
  process.exit(1);
});
