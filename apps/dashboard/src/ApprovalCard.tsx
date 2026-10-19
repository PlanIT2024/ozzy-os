import { useRef, useState } from 'react';
import { approvalAction, commandClick, isPending, type Approval, type Node, type Run } from './model';
export function ApprovalCard({ a, nodes, runs, user, now, busy, decide }: { a: Approval; nodes: Node[]; runs: Run[]; user: string; now: number; busy: boolean; decide: (a: Approval, status: 'approved' | 'denied') => Promise<void> }) {
 const locked = useRef(false);
 const [armed, setArmed] = useState(0), [sending, setSending] = useState(false);
 const node = nodes.find(n => n.id === a.node_id), run = runs.find(r => r.id === a.action_detail?.run_id), action = approvalAction(a), pending = isPending(a, now), owner = !!user && node?.owner_id === user;
 async function send(status: 'approved' | 'denied') {
  if (locked.current || sending || busy || !owner || !isPending(a, Date.now())) return;
  if (status === 'approved') { const click = commandClick(a.action_detail?.kind !== 'run' && action.command, armed, Date.now()); setArmed(click.armedUntil); if (!click.decide) return; }
  locked.current = true; setSending(true); try { await decide(a, status); } finally { locked.current = false; setSending(false); setArmed(0); }
 }
 return <article className="approval-card" data-approval-id={a.id}><strong>{run?.executor || String(a.action_detail?.executor || 'Agent')} · {node?.name || 'Unknown machine'}</strong>{run && <p>Folder: {run.folder_alias} · Lease: {run.lease_minutes} min</p>}{a.action_detail?.kind === 'run' && run ? <><p className="plain">{run.prompt.slice(0, 400)}</p></> : <p className="plain">{action.command ? <code>{action.text}</code> : action.text}</p>}<p>{pending ? `${Math.ceil((Date.parse(a.expires_at!) - now) / 1000)}s remaining` : a.status === 'approved' ? 'Approved' : a.status === 'denied' ? 'Denied' : a.status === 'decided' ? 'Decided elsewhere' : 'Expired'}</p>{pending && (owner ? <div className="row"><button disabled={busy || sending} onClick={() => void send('approved')}>{armed > now ? 'Approve command?' : 'Approve'}</button><button disabled={busy || sending} onClick={() => void send('denied')}>Deny</button></div> : <p>Waiting for {node?.name || 'machine'} owner</p>)}</article>;
}
