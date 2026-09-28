import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
export function machineTools(hub) {
  const result = value => ({ content: [{ type: 'text', text: JSON.stringify(value) }] });
  return createSdkMcpServer({ name: 'machines', version: '1.0.0', tools: [
    tool('list_machines', 'List registered machines and their online/offline state.', {}, async () => result(hub.list())),
    tool('machine_status', 'Get live read-only status for one machine: uptime, CPU, memory, disks, battery, users and OS.', { machine: z.string().min(1).max(64) }, async ({ machine }) => {
      try { return result(await hub.request(machine, 'status')); }
      catch (error) { return { ...result({ error: error.message }), isError: true }; }
    }),
  ] });
}
