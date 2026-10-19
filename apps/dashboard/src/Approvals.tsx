import { ApprovalCard } from './ApprovalCard';
import { isPending, type Approval, type Node, type Run } from './model';
export function Approvals({ approvals, nodes = [], runs = [], user = '', now = Date.now(), busy = false, decide = async () => {} }: { approvals: Approval[]; nodes?: Node[]; runs?: Run[]; user?: string; now?: number; busy?: boolean; decide?: (a: Approval, status: 'approved' | 'denied') => Promise<void> }) {
 return <section className="approvals"><h2>Approvals <small>{approvals.filter(a => isPending(a, now)).length} pending</small></h2>{approvals.length ? approvals.map(a => <ApprovalCard key={a.id} {...{ a, nodes, runs, user, now, busy, decide }} />) : <p className="empty">No pending approvals.</p>}</section>;
}
