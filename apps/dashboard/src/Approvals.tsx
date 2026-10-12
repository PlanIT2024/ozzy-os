import type { Approval } from './model';
export function Approvals({ approvals }: { approvals: Approval[] }) {
 return <section><h2>Approvals <small>{approvals.length} pending</small></h2><p className="muted">Decide in Discord for now</p>{approvals.length ? approvals.map(a => <article key={a.id}><strong>{a.action_summary}</strong><p>{a.risk} · {new Date(a.requested_at).toLocaleString()}</p></article>) : <p className="empty">No pending approvals.</p>}</section>;
}
