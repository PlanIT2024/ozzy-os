export const columns = ['inbox', 'planned', 'running', 'waiting_on_you', 'done'] as const;
export type TaskStatus = typeof columns[number] | 'cancelled';
export interface Task { id: string; workspace_id: string; title: string; description: string | null; status: TaskStatus; project_id: string | null; goal_id: string | null; node_id: string | null; due_date: string | null; executor?: string; external_ref?: { discord_thread_id?: string } }
export interface Node { id: string; name: string; os: string | null; capabilities: string[]; status: string; last_seen_at: string | null; owner_id?: string; metadata?: { agent?: { executors: string[]; folders: string[]; maxLeaseMinutes: number } } }
export interface Project { id: string; name: string; status: string }
export interface Goal { id: string; project_id: string; title: string }
export interface Approval { id: string; action_summary: string; risk: string; requested_at: string; task_id?: string; node_id?: string; status?: string; expires_at?: string; action_detail?: Record<string, unknown> }
export interface Event { task_id?: string; id: number; created_at: string; kind: string; summary: string | null; model: string | null; cost_cents: number }
export function nodeStatus(node: Pick<Node, 'status' | 'last_seen_at'>, now = Date.now()) {
 if (node.status !== 'online') return node.status;
 const seen = node.last_seen_at ? Date.parse(node.last_seen_at) : NaN;
 return !Number.isFinite(seen) || now - seen > 180_000 ? 'stale' : 'online';
}
export function lastSeen(value: string | null, now = Date.now()) {
 if (!value || !Number.isFinite(Date.parse(value))) return 'Never seen';
 const minutes = Math.max(0, Math.floor((now - Date.parse(value)) / 60000));
 return minutes < 1 ? 'Last seen just now' : `Last seen ${minutes < 60 ? `${minutes}m` : minutes < 1440 ? `${Math.floor(minutes / 60)}h` : `${Math.floor(minutes / 1440)}d`} ago`;
}
export function tasksInColumn(tasks: Task[], status: typeof columns[number]) { return tasks.filter(task => task.status === status); }
export function quickAddPayload(workspace_id: string, title: string) { return { workspace_id, title: title.trim(), status: 'inbox', source: 'typed' }; }

export interface Run { started_at?: string | null; id: string; task_id: string; node_id: string; executor: string; folder_alias: string; prompt: string; lease_minutes: number; status: string; stop_requested: boolean; branch: string | null; summary: string | null; created_at: string }
export function machineOptions(node: Node, now = Date.now()) {
 const agent = node.metadata?.agent;
 if (!node.capabilities.includes('run_agent')) return { reason: 'Not enabled', executors: [], folders: [], leases: [] };
 if (nodeStatus(node, now) !== 'online') return { reason: nodeStatus(node, now), executors: [], folders: [], leases: [] };
 const executors = (agent?.executors || []).filter(x => ['codex', 'claude_code'].includes(x));
 const folders = (agent?.folders || []).filter(x => typeof x === 'string');
 const leases = [20, 40, 60].filter(x => x <= (agent?.maxLeaseMinutes || 0));
 return { reason: executors.length && folders.length && leases.length ? '' : 'No supported executor, folder or lease advertised', executors, folders, leases };
}
export function runPayload(id: string, task_id: string, node_id: string, executor: string, folder_alias: string, prompt: string, lease_minutes: number, requested_by: string) {
 return { id, task_id, node_id, executor, folder_alias, prompt, lease_minutes, status: 'requested', requested_by };
}
export const decisionPayload = (status: 'approved' | 'denied', user: string) => ({ status, decided_by: user });
export const stopPayload = () => ({ stop_requested: true });
export const canStop = (run: Run, nodes: Node[], user: string) => ['dispatched', 'running'].includes(run.status) && nodes.some(n => n.id === run.node_id && n.owner_id === user);
export const isPending = (a: Approval, now: number) => (!a.status || a.status === 'pending') && Number.isFinite(Date.parse(a.expires_at || '')) && Date.parse(a.expires_at!) > now;
export const tabTitle = (count: number) => count ? `(${count}) bIT OS` : 'bIT OS';
export function approvalAction(a: Approval) {
 const d = a.action_detail || {};
 const detail = d.detail && typeof d.detail === 'object' ? d.detail as Record<string, unknown> : d;
 const action = String(d.tool || d.action || a.action_summary);
 const command = /command|bash|shell/i.test(action) || (typeof detail.command === 'string' && !!detail.command);
 const path = detail.file_path || detail.path || detail.filePath || (Array.isArray(detail.paths) ? detail.paths.join(', ') : null);
 return { command, text: command ? `Run command: ${typeof detail.command === 'string' ? detail.command : action}` : path ? `Write ${String(path)}` : action };
}
export function commandClick(command: boolean, armedUntil: number, now: number) { return command && now >= armedUntil ? { decide: false, armedUntil: now + 5000 } : { decide: true, armedUntil: 0 }; }
