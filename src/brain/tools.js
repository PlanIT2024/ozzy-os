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
export function reminderTools(reminders, { channel, notify = async () => {} }) {
  const result = value => ({ content: [{ type: 'text', text: JSON.stringify(value) }] });
  const guarded = handler => async input => {
    try { return result(await handler(input)); }
    catch (error) { return { ...result({ error: error.message }), isError: true }; }
  };
  return createSdkMcpServer({ name: 'reminders', version: '1.0.0', tools: [
    tool('set_reminder', 'Set an owner reminder. Accept natural time (in 20 minutes, tomorrow at 3pm) or an exact ISO timestamp. TZ applies. Always report the exact resolved time and id returned.', { when: z.string().min(1).max(300), text: z.string().min(1).max(1500) }, guarded(async ({ when, text }) => {
      const saved = reminders.set(reminders.proposal(when, text), channel);
      await notify(saved.confirmation); return saved;
    })),
    tool('list_reminders', 'List pending reminders, exact resolved times, ids and any uncertain delivery records. Read-only.', {}, guarded(() => reminders.list())),
    tool('cancel_reminder', 'Cancel a pending owner reminder by id.', { id: z.string().uuid() }, guarded(({ id }) => reminders.cancel(id))),
  ] });
}
export function screenshotTools(screen) {
  return createSdkMcpServer({ name: 'screens', version: '1.0.0', tools: [
    tool('screenshot', 'Read-only screenshot of a machine with screen capability. Requires an active owner /screen on grant in this conversation; never available for scheduled jobs. Describe visible facts; do not repeat passwords, tokens, keys or card numbers. Report unclear text honestly.', { machine: z.string().min(1).max(64) }, ({ machine }) => screen.capture(machine)),
  ] });
}
