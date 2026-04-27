import piBraid from './dist/test-build/index.js';

const mockPi = {
  registerTool: () => {},
  registerCommand: () => {},
  registerFlag: () => {},
  on: () => {},
  getAllTools: () => [],
  getActiveTools: () => [],
  setActiveTools: () => {},
  appendEntry: () => {},
  setLabel: () => {},
  setSessionName: () => {},
  getSessionName: () => null,
  sendMessage: () => {},
  sendUserMessage: () => {},
  events: { emit: () => {}, on: () => {} },
  getFlag: () => undefined,
  getCommands: () => [],
  modelRegistry: { getApiKeyAndHeaders: async () => ({ ok: false, error: 'no model' }) },
  ui: {
    notify: () => {},
    setStatus: () => {},
    custom: async () => {},
    hasUI: false,
    theme: { fg: (c, s) => s, bold: (s) => s },
    select: async () => undefined,
  },
  model: null,
  compact: () => {},
  reload: () => {},
  input: () => ({ action: 'continue' }),
  hasUI: false,
};

try {
  piBraid(mockPi);
  console.log('✓ Extension factory runs without errors');
} catch (e) {
  console.error('✗ Extension factory threw:', e.message);
  process.exit(1);
}
