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

export function computerTools(control) {
  return createSdkMcpServer({ name: 'computer', version: '1.0.0', tools: [
    tool('computer', control.taskMode?'Task mode: propose_task first. Then inspect with screenshot. Approved scope actions need no additional cards. Use raise_app for allowed apps; raw Shell input is forbidden. Include expected_app from the actual reported allowed app. Node refuses text, app, key or hazard violations: stop and ask, never retry. Sending, terminals, credentials, payments, unexpected dialogs and closing work require handback or step mode.':'Owner step-approved computer control. First inspect with screenshot. Input actions need the owner button; screenshots are automatic under the active control grant and count toward caps. Cards show real focused app/window. Every input call must include expected_app equal to the intended app identifier from node focus (special gnome-shell-search requires active overview and observed search focus). Mismatches are refused before a card. Verify reported focus after clicks before type/key; prefer launch_app for starting apps. For an owner-requested overview raise: approve lone Super, then focus_search with expected_app gnome-shell (unique editable Overview target), then verify gnome-shell-search before approving app-name type and Enter; never press Super twice in a row. On any refusal stop and explain, never retry variations. Discord is blocked except lone Super (still needs a button); obtain and verify new Shell search/allowed app focus before typing, never assume Super succeeded. Cards label focused-window extent fallback when inner accessibility is missing. Explain refusal cause (missing accessibility, overlap, focus mismatch); stop on unexpected focus, never repair in another app. State target/intent before each step; coordinates use the most recent scaled screenshot. After input a fresh verification screenshot is returned. Stop on login/2FA/payment, sensitive credentials, unexpected screen or denial. Never change security settings.', {
      machine: z.string().min(1).max(64), action: z.enum(['screenshot','mouse_move','left_click','right_click','double_click','drag','scroll','key','type','focus_search']), target: z.string().min(1).max(240),
      coordinate: z.array(z.number()).length(2).optional(), end: z.array(z.number()).length(2).optional(), keys: z.string().max(80).optional(), text: z.string().max(1000).optional(), direction: z.enum(['up','down','left','right']).optional(), amount: z.number().int().min(1).max(20).optional(), expected_app:z.string().min(1).max(160).optional(),
    }, input => control.execute(input)),
    ...(control.taskMode?[
      tool('propose_task','Propose the complete task scope before any input. Owner button only, never chat approval. List exact installed desktop IDs, exact typed strings and explicit action types; free_text_apps is separately flagged, never terminals. Browsers warn and taint the thread. Scope ends on Stop, expiry, cap or finish. Use list_apps to discover IDs.',{machine:z.string().min(1).max(64),goal:z.string().min(1).max(800),allowed_apps:z.array(z.string()).min(1).max(12),texts:z.array(z.string()).max(40),allowed_actions:z.array(z.string()).min(1),max_steps:z.number().int().min(1).max(40).optional(),max_minutes:z.number().int().min(1).max(10).optional(),free_text_apps:z.array(z.string()).optional(),key_combos:z.array(z.string()).optional()},input=>control.propose(input)),
      tool('raise_app','Raise an allowed installed desktop ID using the fixed node macro: launch, verify, then if needed Super, focus_search, approved app display-name search and Enter. No improvising. On any failure stop and ask Ozzy.',{machine:z.string().min(1).max(64),app:z.string().min(1).max(160)},input=>control.execute({...input,action:'raise_app'})),
      tool('finish_task','Finish this task and release held input. New actions require a new approved plan.',{machine:z.string().min(1).max(64)},input=>control.execute({...input,action:'finish_task'})),
      tool('list_apps','Read installed desktop IDs and app classifications for a task plan. No launch or input.',{machine:z.string().min(1).max(64)},input=>control.execute({...input,action:'list_apps'})),
    ]:[]),
    tool('launch_app',control.taskMode?'Launch an allowed installed desktop app within the approved task scope. Prefer raise_app when it must become focused. No extra card; scope, focus and safety checks apply. Stop and ask on failure.':'Launch an installed desktop app by exact desktop id or unambiguous name. Requires active untainted control/screen grants and owner ✅. Prefer this over keyboard launching. Discord launches are blocked. The node resolves the installed entry before approval and re-checks its fingerprint before launch; afterwards inspect actual reported focus. If the target is not focused, stop and ask Ozzy to bring it forward; do not improvise a raising sequence or retry the launch.',{machine:z.string().min(1).max(64),app:z.string().min(1).max(160)},input=>control.execute({...input,action:'launch_app',target:`Launch ${input.app}`})),
  ] });
}
