import { startNode as startRealNode } from '../../src/node/index.js';
import { AgentBridge } from '../../src/node/agent/bridge.js';

// Legacy node tests must never consume the machine's live opt-in policy or
// connect to its coordinator. Agent protocol tests inject their own manager.
export function startNode(options) {
  return startRealNode({
    ...options,
    agents: new AgentBridge({ policy: () => ({ enabled: false }), connect: async () => { throw new Error('Live coordinator access forbidden in tests'); } }),
  });
}
