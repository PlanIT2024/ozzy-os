import { startNode as startRealNode } from '../../src/node/index.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NodeGrants } from '../../src/node/grants/index.js';
import { AgentBridge } from '../../src/node/agent/bridge.js';

// Legacy node tests must never consume the machine's live opt-in policy or
// connect to its coordinator. Agent protocol tests inject their own manager.
export function startNode(options) {
  return startRealNode({
    ...options,
    grants:options.grants||new NodeGrants({root:fs.mkdtempSync(path.join(os.tmpdir(),'test-node-grants-')),file:'/nonexistent/test-local-policy',serve:false,notify:async()=>{}}),
    agents: new AgentBridge({ policy: () => ({ enabled: false }), connect: async () => { throw new Error('Live coordinator access forbidden in tests'); } }),
  });
}
