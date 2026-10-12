export const columns = ['inbox', 'planned', 'running', 'waiting_on_you', 'done'] as const;
export type TaskStatus = typeof columns[number] | 'cancelled';
export interface Task { id: string; workspace_id: string; title: string; description: string | null; status: TaskStatus; project_id: string | null; goal_id: string | null; node_id: string | null; due_date: string | null; executor?: string; external_ref?: { discord_thread_id?: string } }
export interface Node { id: string; name: string; os: string | null; capabilities: string[]; status: string; last_seen_at: string | null }
export interface Project { id: string; name: string; status: string }
export interface Goal { id: string; project_id: string; title: string }
export interface Approval { id: string; action_summary: string; risk: string; requested_at: string }
export interface Event { id: number; created_at: string; kind: string; summary: string | null; model: string | null; cost_cents: number }
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
