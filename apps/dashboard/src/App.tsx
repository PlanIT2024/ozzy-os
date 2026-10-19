import { BitPresence } from './BitPresence';
import { useEffect, useRef, useState, lazy, Suspense, type FormEvent } from 'react';
import type { Session } from '@supabase/supabase-js';
import { supabase } from './client';
import { columns, lastSeen, nodeStatus, quickAddPayload, tasksInColumn, type Task, type Node, type Project, type Goal, type Approval, type Event } from './model';
const MachineAccess=lazy(()=>import('./Access').then(module=>({default:module.MachineAccess})));
import { TaskRuns, stopAgentRun } from './TaskRuns';
import { decisionPayload, isPending, tabTitle, type Run } from './model';
import { Approvals } from './Approvals';
type Workspace = { id: string; name: string };
const label = (value: string) => value.replaceAll('_', ' ');
export function App() {
 const [session, setSession] = useState<Session | null>(null), [ready, setReady] = useState(false);
 const [error, setError] = useState(''), [workspaces, setWorkspaces] = useState<Workspace[]>([]), [workspace, setWorkspace] = useState('');
 const [tasks, setTasks] = useState<Task[]>([]), [nodes, setNodes] = useState<Node[]>([]), [projects, setProjects] = useState<Project[]>([]), [goals, setGoals] = useState<Goal[]>([]), [approvals, setApprovals] = useState<Approval[]>([]), [events, setEvents] = useState<Event[]>([]);
 const [runs, setRuns] = useState<Run[]>([]);
 const [selected, setSelected] = useState<Task | null>(null), [busy, setBusy] = useState(false), [loading, setLoading] = useState(false), [now, setNow] = useState(Date.now());
 const [logTask, setLogTask] = useState<string | null>(null);
 useEffect(() => { if (selected && selected.id === logTask) { const section = document.getElementById(`task-log-${selected.id}`); section?.scrollIntoView({block:'start'}); section?.focus({preventScroll:true}); } }, [selected, logTask]);
 const refresh = useRef<() => Promise<void>>(async () => {});
 const scope = useRef(''); scope.current = `${session?.user.id || ''}:${workspace}`;
 useEffect(() => {
  if (!supabase) { setReady(true); return; }
  let active = true;
  const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, value) => { if (active) { setSession(value); setReady(true); setError(''); } });
  supabase.auth.getSession().then(({ data, error }) => { if (active) { setSession(data.session); setReady(true); if (error) setError(error.message); } });
  return () => { active = false; subscription.unsubscribe(); };
 }, []);
 useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, []);
 useEffect(() => {
  setWorkspace(''); setWorkspaces([]); setSelected(null);
  if (!session || !supabase) return;
  let active = true;
  supabase.from('workspace_members').select('workspace_id,workspaces!inner(id,name)').eq('user_id', session.user.id).then(({ data, error }) => {
   if (!active) return;
   if (error) { setError(error.message); return; }
   const items = (data || []).map(row => row.workspaces as unknown as Workspace);
   setWorkspaces(items);
   const saved = localStorage.getItem(`bitos-workspace:${session.user.id}`);
   setWorkspace(items.find(item => item.id === saved)?.id || items[0]?.id || '');
  });
  return () => { active = false; };
 }, [session?.user.id]);
 useEffect(() => {
  setRuns([]); setTasks([]); setNodes([]); setProjects([]); setGoals([]); setApprovals([]); setEvents([]); setSelected(null);
  refresh.current = async () => {};
  if (!session || !workspace || !supabase) { setLoading(false); return; }
  localStorage.setItem(`bitos-workspace:${session.user.id}`, workspace);
  let active = true, revision = 0;
  const client = supabase;
  async function load() {
   const request = ++revision;
   const results = await Promise.all([
    client.from('agent_runs').select('*,tasks!inner(workspace_id)').eq('tasks.workspace_id', workspace).order('created_at', { ascending: false }),
    client.from('nodes').select('*').order('name'),
    client.from('tasks').select('*').eq('workspace_id', workspace).order('created_at', { ascending: false }),
    client.from('projects').select('*').eq('workspace_id', workspace).order('name'),
    client.from('goals').select('*,projects!inner(workspace_id)').eq('projects.workspace_id', workspace),
    client.from('approvals').select('*,tasks!inner(workspace_id)').eq('tasks.workspace_id', workspace).eq('status', 'pending').order('requested_at', { ascending: false }),
    client.from('task_events').select('*,tasks!inner(workspace_id)').eq('tasks.workspace_id', workspace).order('created_at', { ascending: false }).order('id', { ascending: false }).limit(50)
   ]);
   if (!active || request !== revision) return;
   const failure = results.find(result => result.error)?.error;
   if (failure) setError(failure.message);
   else { setRuns(results[0].data as Run[]); setNodes(results[1].data as Node[]); setTasks(results[2].data as Task[]); setProjects(results[3].data as Project[]); setGoals(results[4].data as Goal[]); setApprovals(results[5].data as Approval[]); setEvents(results[6].data as Event[]); }
   setLoading(false);
  }
  refresh.current = load; setLoading(true);
  const channel = client.channel(`dashboard:${session.user.id}:${workspace}`);
  for (const table of ['nodes', 'tasks', 'approvals', 'task_events', 'agent_runs']) {
   channel.on('postgres_changes', { event: '*', schema: 'public', table, ...(table === 'tasks' ? { filter: `workspace_id=eq.${workspace}` } : {}) }, () => { void load(); });
  }
  channel.subscribe(status => { if (active && status === 'SUBSCRIBED') void load(); if (active && (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT')) setError('Live updates disconnected. Use Refresh to fetch the latest data.'); });
  void load();
  return () => { active = false; revision++; void client.removeChannel(channel); };
 }, [session?.user.id, workspace]);
 const pendingCount = session && workspace ? approvals.filter(a => isPending(a, now)).length : 0;
 useEffect(() => { document.title = tabTitle(pendingCount); return () => { document.title = 'bIT OS'; }; }, [pendingCount]);
 async function mutate(action: () => PromiseLike<{ error: { message: string } | null; data?: unknown }>, after?: () => void) {
  const started = scope.current; setBusy(true); setError('');
  try { const result = await action(); if (result.error) throw result.error; if (started === scope.current) { after?.(); await refresh.current(); } }
  catch (failure) { if (started === scope.current) setError(failure instanceof Error ? failure.message : (failure as { message: string }).message); }
  finally { setBusy(false); }
 }
 async function signIn(event: FormEvent<HTMLFormElement>) {
  event.preventDefault(); const form = new FormData(event.currentTarget);
  await mutate(() => supabase!.auth.signInWithPassword({ email: String(form.get('email')), password: String(form.get('password')) }));
 }
 if (!supabase) return <main className="signin"><h1>bIT OS</h1><p>Configure VITE_SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_KEY in apps/dashboard/.env.local, then restart the dev server.</p></main>;
 if (!ready) return <main><p>Restoring session…</p></main>;
 if (!session) return <main className="signin"><div className="eyebrow">OZZY / OPERATING SYSTEM</div><h1>bIT OS</h1><p className="muted">Your machines. Your work. One place.</p><form onSubmit={signIn}><label>Email<input name="email" type="email" autoComplete="username" required /></label><label>Password<input name="password" type="password" autoComplete="current-password" required /></label><button disabled={busy}>Sign in</button></form>{error && <p role="alert">{error}</p>}</main>;
 const decideApproval = (a: Approval, status: 'approved' | 'denied') => mutate(() => supabase!.from('approvals').update(decisionPayload(status, session.user.id)).eq('id', a.id).eq('status', 'pending').select('id').single());
 const writable = !!workspace && !busy && !loading;
 return <><header><div><span className="eyebrow">OZZY / OPERATING SYSTEM</span><h1>bIT OS <small>Dashboard</small></h1></div><div className="toolbar"><BitPresence key={`${workspace}:${session.user.id}`} {...{approvals,nodes,runs,tasks,workspace,now,busy,error}} user={session.user.id} decide={decideApproval} stop={run=>stopAgentRun(mutate,run)} viewTask={task=>{setLogTask(null);setSelected(task);}} viewLog={task=>{setLogTask(task.id);setSelected(task);}}/><label>Workspace<select value={workspace} onChange={e => { setError(''); setSelected(null); setWorkspace(e.target.value); }}>{workspaces.map(ws => <option key={ws.id} value={ws.id}>{ws.name}</option>)}</select></label><button onClick={() => void refresh.current()} disabled={!workspace || loading}>Refresh</button><button disabled={busy} onClick={() => void mutate(() => supabase!.auth.signOut())}>Sign out</button></div></header><main className={pendingCount ? 'has-pending' : ''}>
 {error && <div className="notice" role="alert">{error}<button onClick={() => setError('')} aria-label="Dismiss error">×</button></div>}
 {!workspace ? <p>No workspace memberships found.</p> : <><div className="page-title"><h2>Workspace overview</h2><span className="muted">{loading ? 'Loading…' : session.user.email}</span></div>
 <section><h2>Machines <small>{nodes.length} visible</small></h2><div className="machines">{nodes.map(node => <article key={node.id}><div className="row"><strong>{node.name}</strong><span className={`status ${nodeStatus(node, now)}`}><i />{nodeStatus(node, now)}</span></div><p className="muted">{node.os || 'Unknown OS'} · {lastSeen(node.last_seen_at, now)}</p><Suspense fallback={null}><MachineAccess node={node} workspace={workspace} user={session.user.id}/></Suspense><div className="chips">{node.capabilities.map(cap => <span key={cap}>{cap}</span>)}</div></article>)}</div>{!nodes.length && <p className="empty">No visible machines.</p>}</section>
 <section><h2>Projects</h2><form className="inline" onSubmit={event => { event.preventDefault(); const form = event.currentTarget; const name = String(new FormData(form).get('name')).trim(); if (name) void mutate(() => supabase!.from('projects').insert({ workspace_id: workspace, name }), () => form.reset()); }}><input name="name" aria-label="New project name" placeholder="New project name" required /><button disabled={!writable}>Create project</button></form><div className="projects">{projects.map(project => <article key={project.id}><form className="inline" onSubmit={event => { event.preventDefault(); const name = String(new FormData(event.currentTarget).get('name')).trim(); if (name) void mutate(() => supabase!.from('projects').update({ name }).eq('id', project.id).eq('workspace_id', workspace).select('id').single()); }}><ProjectName project={project} /><button disabled={!writable}>Rename</button></form><div className="row"><span className="muted">{project.status}</span><button disabled={!writable || project.status === 'archived'} onClick={() => void mutate(() => supabase!.from('projects').update({ status: 'archived' }).eq('id', project.id).eq('workspace_id', workspace).select('id').single())}>Archive</button></div></article>)}</div></section>
 <section><h2>Tasks <small>{tasks.length} total</small></h2><form className="inline quick-add" onSubmit={event => { event.preventDefault(); const form = event.currentTarget; const title = String(new FormData(form).get('title')).trim(); if (title) void mutate(() => supabase!.from('tasks').insert(quickAddPayload(workspace, title)), () => form.reset()); }}><input name="title" placeholder="What needs to happen? Add to inbox…" aria-label="New task title" required /><button disabled={!writable}>Add task</button></form><div className="board">{columns.map(status => <div className="column" key={status}><h3>{label(status)} <small>{tasksInColumn(tasks, status).length}</small></h3>{tasksInColumn(tasks, status).map(task => <button className="task" key={task.id} onClick={() => setSelected(task)}><strong>{task.title}</strong>{runs.some(r => r.task_id === task.id && ['dispatched', 'running'].includes(r.status)) && <span className="running-indicator">● Running</span>}{approvals.some(a => a.task_id === task.id && isPending(a, now)) && <span className="pill">{approvals.filter(a => a.task_id === task.id && isPending(a, now)).length} pending approval</span>}{task.due_date && <span className="muted">Due {task.due_date}</span>}</button>)}{!tasksInColumn(tasks, status).length && <p className="empty">No tasks</p>}</div>)}</div>{tasks.some(t => t.status === 'cancelled') && <details><summary>Cancelled tasks</summary>{tasks.filter(t => t.status === 'cancelled').map(t => <button key={t.id} onClick={() => setSelected(t)}>{t.title}</button>)}</details>}</section>
 <div className="lower"><Approvals {...{ approvals, nodes, runs, now, busy }} user={session.user.id} decide={decideApproval} /><section><h2>Activity <small>Latest 50</small></h2>{events.length ? events.map(event => <article key={event.id}><div className="row"><strong>{event.kind}</strong><time dateTime={event.created_at}>{new Date(event.created_at).toLocaleString()}</time></div><p>{event.summary || 'No summary'}</p><p className="muted">{event.model || 'No model'} · ${(Number(event.cost_cents) / 100).toFixed(4)}</p></article>) : <p className="empty">No activity yet.</p>}</section></div></>}
 </main>{selected && <TaskPanel key={`${workspace}:${session.user.id}:${selected.id}`} task={selected} runContent={<TaskRuns task={selected} nodes={nodes} user={session.user.id} runs={runs.filter(r => r.task_id === selected.id)} now={now} busy={busy} mutate={mutate} />} panelError={error} projects={projects} goals={goals} nodes={nodes} busy={busy} close={() => {setSelected(null);setLogTask(null);}} save={patch => void mutate(() => supabase!.from('tasks').update(patch).eq('id', selected.id).eq('workspace_id', workspace).select('id').single(), () => setSelected(null))} />}</>;
}
function TaskPanel({ task, projects, goals, nodes, busy, close, save, runContent, panelError }: { runContent: React.ReactNode; panelError: string; task: Task; projects: Project[]; goals: Goal[]; nodes: Node[]; busy: boolean; close: () => void; save: (patch: Partial<Task>) => void }) {
 const [project, setProject] = useState(task.project_id || ''), [goal, setGoal] = useState(task.goal_id || '');
 const dialog = useRef<HTMLDialogElement>(null);
 useEffect(() => { dialog.current?.showModal(); }, []);
 return <dialog ref={dialog} className="panel" onCancel={close}><div className="row"><h2>Edit task</h2><button onClick={close} aria-label="Close task panel">×</button></div><form onSubmit={event => { event.preventDefault(); const data = new FormData(event.currentTarget); save({ title: String(data.get('title')).trim(), description: String(data.get('description')).trim() || null, project_id: project || null, goal_id: goal || null, node_id: String(data.get('node')) || null, status: String(data.get('status')) as Task['status'], due_date: String(data.get('due_date')) || null }); }}><label>Title<input name="title" defaultValue={task.title} required pattern=".*\S.*" /></label><label>Description<textarea name="description" defaultValue={task.description || ''} rows={5} /></label><label>Project<select value={project} onChange={event => { setProject(event.target.value); setGoal(''); }}><option value="">No project</option>{projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label><label>Goal<select value={goal} onChange={e => setGoal(e.target.value)}><option value="">No goal</option>{goals.filter(g => g.project_id === project).map(g => <option key={g.id} value={g.id}>{g.title}</option>)}</select></label><label>Node<select name="node" defaultValue={task.node_id || ''}><option value="">No node</option>{nodes.map(n => <option key={n.id} value={n.id}>{n.name}</option>)}</select></label><label>Status<select name="status" defaultValue={task.status}>{[...columns, 'cancelled'].map(s => <option key={s} value={s}>{label(s)}</option>)}</select></label><label>Due date<input name="due_date" type="date" defaultValue={task.due_date || ''} /></label>{task.executor && <p>Executor: <strong>{task.executor}</strong></p>}{task.external_ref?.discord_thread_id && <p className="thread">Discord thread: {task.external_ref.discord_thread_id}</p>}<button disabled={busy}>Save changes</button></form>{panelError && <p role="alert">{panelError}</p>}{runContent}</dialog>;
}

export function ProjectName({ project }: { project: Project }) {
 const [name, setName] = useState(project.name);
 useEffect(() => { setName(project.name); }, [project.id, project.name]);
 return <input name="name" value={name} onChange={event => setName(event.target.value)} aria-label={`Rename ${project.name}`} required />;
}
