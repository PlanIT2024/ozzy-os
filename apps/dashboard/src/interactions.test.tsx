import { beforeEach, expect, it, vi } from 'vitest';
import type { ReactElement } from 'react';
const hooks = vi.hoisted(() => ({ values: [] as unknown[], cursor: 0, effects: [] as (() => void | (() => void))[] }));
const db = vi.hoisted(() => ({ from: vi.fn(), channel: vi.fn(), removeChannel: vi.fn() }));
vi.mock('react', async importOriginal => ({ ...await importOriginal<typeof import('react')>(),
 useState: (initial: unknown) => { const i = hooks.cursor++; if (!(i in hooks.values)) hooks.values[i] = initial; return [hooks.values[i], (value: unknown) => { hooks.values[i] = value; }]; },
 useRef: (initial: unknown) => { const i = hooks.cursor++; if (!(i in hooks.values)) hooks.values[i] = { current: initial }; return hooks.values[i]; },
 useEffect: (effect: () => void | (() => void)) => { hooks.effects.push(effect); }
}));
vi.mock('./client', () => ({ supabase: db }));
import { Approvals } from './Approvals';
import { TaskRuns, RunForm, RunList } from './TaskRuns';
import type { Approval, Node, Task } from './model';
const now = Date.parse('2026-10-15T12:00:00Z');
const node = { id: 'n', owner_id: 'owner', name: 'MACBOOK' } as Node;
const approval: Approval = { id: 'a', node_id: 'n', action_summary: 'Bash', requested_at: '', risk: 'risky', expires_at: new Date(now + 60000).toISOString(), action_detail: { kind: 'agent', command: 'git status --short' } };
function elements(el: unknown): ReactElement<Record<string, unknown>>[] {
 if (Array.isArray(el)) return el.flatMap(elements);
 if (!el || typeof el !== 'object' || !('props' in el)) return [];
 const item = el as ReactElement<Record<string, unknown>>;
 return [item, ...elements(item.props.children)];
}
function card(a: Approval, decide: (a: Approval, status: 'approved' | 'denied') => Promise<void>) {
 hooks.cursor = 0;
 const tree = Approvals({ approvals: [a], nodes: [node], user: 'owner', now: Date.now(), decide });
 const child = elements(tree).find(e => typeof e.type === 'function')!;
 return (child.type as (props: unknown) => ReactElement)(child.props);
}
const buttons = (el: unknown) => elements(el).filter(e => e.type === 'button');
beforeEach(() => { hooks.values = []; hooks.cursor = 0; hooks.effects = []; vi.clearAllMocks(); vi.useRealTimers(); });
it('actual command handlers require confirmation and block both decisions while sending', async () => {
 vi.useFakeTimers(); vi.setSystemTime(now);
 let finish!: () => void;
 const decide = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
 let tree = card(approval, decide);
 await (buttons(tree)[0].props.onClick as () => Promise<void>)(); expect(decide).not.toHaveBeenCalled();
 tree = card(approval, decide); expect(buttons(tree)[0].props.children).toBe('Approve command?');
 const pending = (buttons(tree)[0].props.onClick as () => Promise<void>)(); expect(decide).toHaveBeenCalledWith(approval, 'approved');
 tree = card(approval, decide); expect(buttons(tree).every(b => b.props.disabled)).toBe(true);
 await (buttons(tree)[1].props.onClick as () => Promise<void>)(); expect(decide).toHaveBeenCalledTimes(1);
 finish(); await pending;
});
it('actual write and deny handlers send on the first click', async () => {
 vi.useFakeTimers(); vi.setSystemTime(now);
 const write = { ...approval, action_summary: 'Write', action_detail: { kind: 'agent', file_path: 'dispatch-proof.txt' } }, decide = vi.fn(async () => {});
 await (buttons(card(write, decide))[0].props.onClick as () => Promise<void>)(); expect(decide).toHaveBeenLastCalledWith(write, 'approved');
 await (buttons(card(write, decide))[1].props.onClick as () => Promise<void>)(); expect(decide).toHaveBeenLastCalledWith(write, 'denied');
});
it('task event subscription uses a task filter and cleanup removes the channel and ignores late results', async () => {
 let resolve!: (value: unknown) => void;
 const query = { select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis(), order: vi.fn().mockReturnThis(), then: (callback: (v: unknown) => unknown) => new Promise(r => { resolve = r; }).then(callback) };
 db.from.mockReturnValue(query);
 const channel = { on: vi.fn().mockReturnThis(), subscribe: vi.fn().mockReturnThis() }; db.channel.mockReturnValue(channel);
 TaskRuns({ task: { id: 't' } as Task, nodes: [], user: 'owner', runs: [], now, busy: false, mutate: async () => {} });
 const cleanup = hooks.effects[0](); await Promise.resolve();
 expect(db.from).toHaveBeenCalledWith('task_events'); expect(query.eq).toHaveBeenCalledWith('task_id', 't');
 expect(channel.on.mock.calls[0][1]).toMatchObject({ table: 'task_events', filter: 'task_id=eq.t' });
 const before = [...hooks.values]; if (cleanup) cleanup(); expect(db.removeChannel).toHaveBeenCalledWith(channel);
 resolve({ data: [{ id: 1 }], error: null }); await Promise.resolve(); await Promise.resolve(); expect(hooks.values).toEqual(before);
});

it('run form submit generates the CLI payload for the selected task and user', async () => {
 vi.stubGlobal('crypto', { randomUUID: () => 'client-uuid' });
 const submit = vi.fn(async () => {});
 const machine = { ...node, capabilities: ['run_agent'], status: 'online', last_seen_at: new Date(now).toISOString(), metadata: { agent: { executors: ['codex'], folders: ['sandbox'], maxLeaseMinutes: 60 } } };
 const tree = RunForm({ task: { id: 't', title: 'Proof', description: 'Write file' } as Task, nodes: [machine], user: 'owner', now, busy: false, submit });
 const form = elements(tree).find(e => e.type === 'form')!;
 (form.props.onSubmit as (event: unknown) => void)({ preventDefault() {} });
 expect(submit).toHaveBeenCalledWith({ id: 'client-uuid', task_id: 't', node_id: 'n', executor: 'codex', folder_alias: 'sandbox', prompt: 'Proof\n\nWrite file', lease_minutes: 20, status: 'requested', requested_by: 'owner' });
 vi.unstubAllGlobals();
});
it('stop callback updates only stop_requested on the selected run', async () => {
 const eq = vi.fn().mockResolvedValue({ error: null }), update = vi.fn(() => ({ eq })); db.from.mockReturnValue({ update });
 const tree = TaskRuns({ task: { id: 't' } as Task, nodes: [], user: 'owner', runs: [], now, busy: false, mutate: async action => { await action(); } });
 const list = elements(tree).find(e => e.type === RunList)!;
 await (list.props.stop as (run: { id: string }) => Promise<void>)({ id: 'r' });
 expect(db.from).toHaveBeenCalledWith('agent_runs'); expect(update).toHaveBeenCalledWith({ stop_requested: true }); expect(eq).toHaveBeenCalledWith('id', 'r');
});
