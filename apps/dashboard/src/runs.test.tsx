import { it, expect, vi } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { renderToStaticMarkup as render } from 'react-dom/server';
import { Approvals } from './Approvals';
import { RunForm, RunList } from './TaskRuns';
import { machineOptions, runPayload, decisionPayload, stopPayload, canStop, tabTitle, isPending, approvalAction, commandClick, type Node, type Task, type Run, type Approval } from './model';
vi.mock('./client', () => ({ supabase: null }));
const now = Date.parse('2026-10-15T12:00:00Z');
const node: Node = { id: 'n', owner_id: 'owner', name: 'MACBOOK', os: 'macOS', capabilities: ['run_agent'], status: 'online', last_seen_at: new Date(now).toISOString(), metadata: { agent: { executors: ['codex', 'claude_code'], folders: ['sandbox'], maxLeaseMinutes: 40 } } };
const task = { id: 't', title: 'Write proof', description: '<img src=x onerror=alert(1)>' } as Task;
const run: Run = { id: 'r', task_id: 't', node_id: 'n', executor: 'codex', folder_alias: 'sandbox', prompt: 'Write proof', lease_minutes: 20, status: 'running', stop_requested: false, branch: 'bitos/proof', summary: null, created_at: new Date(now).toISOString() };
const approval: Approval = { id: 'a', task_id: 't', node_id: 'n', action_summary: 'Bash', risk: 'risky', requested_at: new Date(now).toISOString(), expires_at: new Date(now + 60000).toISOString(), status: 'pending', action_detail: { kind: 'agent', run_id: 'r', action: 'Bash', detail: { command: 'git status --short' } } };
const cards = (a = approval, user = 'owner', time = now) => render(<Approvals approvals={[a]} nodes={[node]} runs={[run]} user={user} now={time} />);
it('gets executors, aliases and capped leases only from advertised metadata', () => {
 expect(machineOptions(node, now)).toEqual({ reason: '', executors: ['codex', 'claude_code'], folders: ['sandbox'], leases: [20, 40] });
 for (const maxLeaseMinutes of [10, 20, 40, 60, 120]) expect(machineOptions({ ...node, metadata: { agent: { ...node.metadata!.agent!, maxLeaseMinutes } } }, now).leases).toEqual([20, 40, 60].filter(x => x <= maxLeaseMinutes));
 expect(machineOptions({ ...node, capabilities: [] }, now).reason).toBe('Not enabled');
 expect(machineOptions({ ...node, status: 'offline' }, now).reason).toBe('offline');
 expect(machineOptions(node, now + 180001).reason).toBe('stale');
 expect(machineOptions({ ...node, metadata: {} }, now).reason).not.toBe('');
 const html = render(<RunForm {...{ task, now }} nodes={[node]} user="owner" busy={false} submit={async () => {}} />);
 expect(html).toContain('sandbox'); expect(html).toContain('40 minutes'); expect(html).not.toContain('60 minutes'); expect(html).toContain('maxLength="8000"'); expect(html).toContain('Write proof'); expect(html).toContain('&lt;img');
});
it('inserts exactly the CLI run fields with the current task and user', () => {
 expect(runPayload('uuid', 't', 'n', 'codex', 'sandbox', 'Prompt', 20, 'owner')).toEqual({ id: 'uuid', task_id: 't', node_id: 'n', executor: 'codex', folder_alias: 'sandbox', prompt: 'Prompt', lease_minutes: 20, status: 'requested', requested_by: 'owner' });
});
it('shows owner decisions, but no buttons for non-owners or expired approvals', () => {
 expect(cards()).toContain('>Approve<'); expect(cards()).toContain('>Deny<'); expect(cards()).toContain('60s remaining');
 expect(cards(approval, 'member')).toContain('Waiting for MACBOOK owner'); expect(cards(approval, 'member')).not.toContain('<button');
 expect(cards(approval, 'owner', now + 60000)).toContain('Expired'); expect(cards(approval, 'owner', now + 60000)).not.toContain('<button');
 expect(cards({ ...approval, expires_at: 'invalid' })).not.toContain('<button');
 const busy = render(<Approvals approvals={[approval]} nodes={[node]} user="owner" now={now} busy />); expect(busy.match(/disabled=""/g)).toHaveLength(2);
});
it('renders readable run and agent details and detects shell approval variants', () => {
 const html = cards({ ...approval, action_detail: { kind: 'run', run_id: 'r' } });
 for (const text of ['codex', 'MACBOOK', 'sandbox', '20 min', 'Write proof']) expect(html).toContain(text);
 expect(cards()).toContain('<code>Run command: git status --short</code>');
 expect(approvalAction({ ...approval, action_detail: { action: 'Write', file_path: 'dispatch-proof.txt' } })).toEqual({ command: false, text: 'Write dispatch-proof.txt' });
 expect(approvalAction({ ...approval, action_summary: 'item/commandExecution/requestApproval', action_detail: { kind: 'agent' } }).command).toBe(true);
});
it('requires a second command click strictly within five seconds, while writes need one', () => {
 const first = commandClick(true, 0, now); expect(first.decide).toBe(false); expect(first.armedUntil).toBe(now + 5000);
 expect(commandClick(true, first.armedUntil, now + 4999).decide).toBe(true);
 expect(commandClick(true, first.armedUntil, now + 5000).decide).toBe(false);
 expect(commandClick(false, 0, now).decide).toBe(true);
});
it('sends decision and stop payloads without stamping decided_at', () => {
 expect(decisionPayload('approved', 'owner')).toEqual({ status: 'approved', decided_by: 'owner' });
 expect(decisionPayload('denied', 'owner')).toEqual({ status: 'denied', decided_by: 'owner' });
 expect(stopPayload()).toEqual({ stop_requested: true });
});
it('only the owner can stop dispatched or running runs and pending stops stay disabled', () => {
 for (const status of ['requested', 'awaiting_approval', 'approved', 'dispatched', 'running', 'done', 'failed', 'stopped', 'expired', 'denied']) {
  expect(canStop({ ...run, status }, [node], 'owner')).toBe(['dispatched', 'running'].includes(status));
  expect(canStop({ ...run, status }, [node], 'member')).toBe(false);
 }
 const list = (user: string, stop_requested = false) => render(<RunList runs={[{ ...run, stop_requested }]} nodes={[node]} user={user} busy={false} stop={async () => {}} />);
 expect(list('owner')).toContain('>Stop<'); expect(list('member')).not.toContain('<button'); expect(list('owner', true)).toContain('disabled="">Stopping…');
});
it('counts only unexpired pending items in the tab title', () => {
 expect(tabTitle(0)).toBe('bIT OS'); expect(tabTitle([approval, { ...approval, status: 'denied' }, { ...approval, expires_at: new Date(now).toISOString() }].filter(a => isPending(a, now)).length)).toBe('(1) bIT OS'); expect(tabTitle(2)).toBe('(2) bIT OS');
});
it('escapes all database content as text without generating links or executable markup', () => {
 const text = '<script>alert(1)</script><a href="javascript:alert(1)">click</a>';
 const html = cards({ ...approval, action_summary: text, action_detail: { kind: 'agent' } });
 expect(html).toContain('&lt;script&gt;'); expect(html).not.toMatch(/<(script|a)\b/);
 const runs = render(<RunList runs={[{ ...run, status: 'done', summary: text, branch: text }]} nodes={[node]} user="owner" busy={false} stop={async () => {}} />);
 expect(runs).toContain('&lt;script&gt;'); expect(runs).not.toMatch(/<(script|a)\b/);
});
it('forbids raw HTML rendering anywhere in dashboard src', () => {
 function scan(dir: URL) { for (const entry of readdirSync(dir, { withFileTypes: true })) { const path = new URL(entry.name + (entry.isDirectory() ? '/' : ''), dir); if (entry.isDirectory()) scan(path); else expect(readFileSync(path, 'utf8')).not.toContain('dangerously' + 'SetInnerHTML'); } }
 scan(new URL('./', import.meta.url));
});
