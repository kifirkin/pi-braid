#!/usr/bin/env node
/**
 * Test stepfun model + SDK: run a prompt and inspect session state
 */
import { createAgentSession, SessionManager, SettingsManager, DefaultResourceLoader, getAgentDir } from '@mariozechner/pi-coding-agent';
import { stepfunModels } from '/Users/kifir/projects/agents/pi-poorman-providers/stepfun.ts';

async function main() {
  const loader = new DefaultResourceLoader({
    cwd: '/Users/kifir/projects/agents/pi-braid',
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
  await loader.reload();

  const { session } = await createAgentSession({
    resourceLoader: loader,
    sessionManager: SessionManager.inMemory(),
    settingsManager: SettingsManager.inMemory({ compaction: { enabled: false } }),
  });

  await session.setModel({ provider: 'stepfun', id: 'step-3.5-flash' });
  console.log('Model:', session.model?.id);

  let text = '';
  session.subscribe((evt) => {
    if (evt.type === 'message_update') {
      const a = evt.assistantMessageEvent;
      if (a) console.log('  event:', a.type, a.delta || a.toolCall?.name || '');
    }
    if (evt.type === 'message_start') {
      console.log('  message_start role:', evt.message?.role);
    }
  });

  console.log('Running prompt...');
  await session.prompt('What is 2+2? Answer in one word.');
  console.log('Messages count:', session.state?.messages?.length);
  const last = session.state?.messages?.at(-1);
  console.log('Last message role:', last?.role);
  const txt = Array.isArray(last?.content) ? last?.content?.[0]?.text : last?.content;
  console.log('Last message content:', String(txt).slice(0, 80));
  console.log('isStreaming:', session.isStreaming);
}

main().catch((err) => {
  console.error('Error:', err);
  process.exit(1);
});
