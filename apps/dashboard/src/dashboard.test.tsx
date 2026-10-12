import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { Approvals } from './Approvals';
import { nodeStatus, columns, tasksInColumn, quickAddPayload, type Task } from './model';
describe('machine freshness', () => {
 const now = Date.parse('2026-10-12T12:00:00Z');
 it('marks recent online nodes green, including the three-minute boundary', () => {
  expect(nodeStatus({ status: 'online', last_seen_at: '2026-10-12T11:57:00Z' }, now)).toBe('online');
 });
 it('marks expired, missing and invalid heartbeats stale', () => {
  for (const last_seen_at of ['2026-10-12T11:56:59Z', null, 'bad']) expect(nodeStatus({ status: 'online', last_seen_at }, now)).toBe('stale');
 });
 it('preserves offline and sleeping even with recent heartbeats', () => {
  for (const status of ['offline', 'sleeping']) expect(nodeStatus({ status, last_seen_at: '2026-10-12T12:00:00Z' }, now)).toBe(status);
 });
});
it('maps all five board statuses without showing cancelled tasks as done', () => {
 expect(columns).toEqual(['inbox', 'planned', 'running', 'waiting_on_you', 'done']);
 const tasks = [...columns, 'cancelled'].map((status, index) => ({ id: String(index), status })) as Task[];
 for (const status of columns) expect(tasksInColumn(tasks, status)).toEqual([tasks.find(task => task.status === status)]);
});
it('quick-add scopes the inbox task and sets its typed source', () => {
 expect(quickAddPayload('workspace-123', '  Build dashboard  ')).toEqual({ workspace_id: 'workspace-123', title: 'Build dashboard', status: 'inbox', source: 'typed' });
});
it('pending approvals render read-only with Discord guidance', () => {
 const html = renderToStaticMarkup(<Approvals approvals={[{ id: '1', action_summary: 'Restart machine', risk: 'risky', requested_at: '2026-10-12T12:00:00Z' }]} />);
 expect(html).toContain('Decide in Discord for now'); expect(html).toContain('Restart machine');
 expect(html).not.toMatch(/<(button|input|form|select|a)\b/i);
 expect(html).not.toMatch(/>\s*(approve|deny)\s*</i);
});
