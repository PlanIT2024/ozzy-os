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
import { ProjectName } from './App';
import { ApprovalCard } from './ApprovalCard';
import { Approvals } from './Approvals';
import { TaskRuns, RunForm, RunList, stopAgentRun } from './TaskRuns';
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
const buttons = (el: unknown) => elements(el).filter(e => e.type === 'button' && e.props.className !== 'detail-toggle');
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
 const write = { ...approval, action_summary: 'Write', action_detail: { kind: 'agent', tool:'Write', command:'', paths:['dispatch-proof.txt'] } }, decide = vi.fn(async () => {});
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

it('project name initializes from the row and follows realtime row changes', () => {
 let tree = ProjectName({project:{id:'p',name:'bIT OS',status:'active'}});
 expect(tree.props.value).toBe('bIT OS');
 (tree.props.onChange as (e: unknown) => void)({target:{value:'Draft'}});
 hooks.cursor=0; hooks.effects=[];
 tree=ProjectName({project:{id:'p',name:'Renamed remotely',status:'active'}});
 hooks.effects.forEach(effect=>effect()); hooks.cursor=0;
 tree=ProjectName({project:{id:'p',name:'Renamed remotely',status:'active'}});
 expect(tree.props.value).toBe('Renamed remotely');
});
it('run blocks short prompts both on button and submit', () => {
 const machine={...node,capabilities:['run_agent'],status:'online',last_seen_at:new Date(now).toISOString(),metadata:{agent:{executors:['codex'],folders:['sandbox'],maxLeaseMinutes:60}}};
 const submit=vi.fn(async()=>{});
 const props={task:{id:'t',title:'Test',description:null} as Task,nodes:[machine],user:'owner',now,busy:false,submit};
 let tree=RunForm(props);
 expect(buttons(tree)[0].props.disabled).toBe(true);
 (elements(tree).find(e=>e.type==='form')!.props.onSubmit as (e:unknown)=>void)({preventDefault(){}});
 expect(submit).not.toHaveBeenCalled();
 (elements(tree).find(e=>e.type==='textarea')!.props.onChange as (e:unknown)=>void)({target:{value:'0123456789'}});
 hooks.cursor=0;tree=RunForm(props);expect(buttons(tree)[0].props.disabled).toBe(false);
});

it('commandExecution detail requires a second click', async () => {
 vi.useFakeTimers();vi.setSystemTime(now);
 const a={...approval,action_summary:'item/commandExecution/requestApproval: sleep 120',action_detail:{kind:'agent',tool:'item/commandExecution/requestApproval',command:'sleep 120',paths:[]}};
 const decide=vi.fn(async()=>{});
 await (buttons(card(a,decide))[0].props.onClick as ()=>Promise<void>)();expect(decide).not.toHaveBeenCalled();
 await (buttons(card(a,decide))[0].props.onClick as ()=>Promise<void>)();expect(decide).toHaveBeenCalledWith(a,'approved');
});

it('current activity and task runs share the existing stop update without approval', async () => {
 const query={update:vi.fn().mockReturnThis(),eq:vi.fn().mockResolvedValue({error:null})};db.from.mockReturnValue(query);
 const mutate=vi.fn(async(action:()=>PromiseLike<{error:{message:string}|null}>)=>{await action();});
 await stopAgentRun(mutate,{id:'run-id'} as import('./model').Run);
 expect(mutate).toHaveBeenCalledTimes(1);expect(db.from).toHaveBeenCalledWith('agent_runs');
 expect(query.update).toHaveBeenCalledWith({stop_requested:true});expect(query.eq).toHaveBeenCalledWith('id','run-id');
});

it('control grants confirm by kind, cap the picker, and pass only selected minutes',async()=>{
 vi.useFakeTimers();vi.setSystemTime(now);
 const machine={...node,metadata:{remote_grants:{screen:true,control:true,screenMinutes:5,controlMinutes:3}}};
 const a:Approval={...approval,action_summary:'Open the editor',action_detail:{access:true,kind:'control',requested_minutes:10,reason:'Open the editor'}};
 const decide=vi.fn(async()=>{});
 const render=()=>{hooks.cursor=0;return ApprovalCard({a,nodes:[machine],runs:[],user:'owner',now,busy:false,decide});};
 let tree=render();expect(elements(tree).filter(e=>e.type==='option')).toHaveLength(3);
 (elements(tree).find(e=>e.type==='select')!.props.onChange as (e:unknown)=>void)({target:{value:'2'}});
 tree=render();await (buttons(tree)[0].props.onClick as ()=>Promise<void>)();expect(decide).not.toHaveBeenCalled();
 tree=render();expect(buttons(tree)[0].props.children).toBe('Confirm access?');await (buttons(tree)[0].props.onClick as ()=>Promise<void>)();expect(decide).toHaveBeenCalledWith(a,'approved',2);
});
it('screen grants use one click and non-owners cannot decide',async()=>{
 vi.useFakeTimers();vi.setSystemTime(now);const machine={...node,metadata:{remote_grants:{screen:true,control:false,screenMinutes:5,controlMinutes:3}}};
 const a:Approval={...approval,action_summary:'See the screen',action_detail:{access:true,kind:'screen',requested_minutes:5}};const decide=vi.fn(async()=>{});
 let tree=ApprovalCard({a,nodes:[machine],runs:[],user:'other',now,busy:false,decide});expect(buttons(tree)).toHaveLength(0);
 hooks.cursor=0;tree=ApprovalCard({a,nodes:[machine],runs:[],user:'owner',now,busy:false,decide});await (buttons(tree)[0].props.onClick as ()=>Promise<void>)();expect(decide).toHaveBeenCalledWith(a,'approved',5);
});
