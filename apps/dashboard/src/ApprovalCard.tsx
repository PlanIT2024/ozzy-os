import { useRef, useState } from 'react';
import { approvalAction, commandClick, isPending, type Approval, type Node, type Run } from './model';
export function ApprovalCard({ a, nodes, runs, user, now, busy, decide }: { a: Approval; nodes: Node[]; runs: Run[]; user: string; now: number; busy: boolean; decide: (a: Approval, status: 'approved' | 'denied', minutes?:number) => Promise<void> }) {
 const access=a.action_detail?.access===true,kind=String(a.action_detail?.kind||''),grant=access&&kind!=='input';
 const p=nodes.find(n=>n.id===a.node_id)?.metadata?.remote_grants;
 const enabled=p?.screen&&(kind==='screen'||p?.control);
 const cap=enabled?Math.min(Number(a.action_detail?.requested_minutes||1),kind==='screen'?15:10,p?.screenMinutes||0,kind==='screen'?15:p?.controlMinutes||0):0;
 const [minutes,setMinutes]=useState(Math.max(1,cap));
 const locked = useRef(false);
 const [armed, setArmed] = useState(0), [sending, setSending] = useState(false);
 const [expanded, setExpanded] = useState(false);
 const node = nodes.find(n => n.id === a.node_id), run = runs.find(r => r.id === a.action_detail?.run_id), action = approvalAction(a), pending = isPending(a, now), owner = !!user && node?.owner_id === user;
 async function send(status: 'approved' | 'denied') {
  if (locked.current || sending || busy || !owner || !isPending(a, Date.now())) return;
  if (status === 'approved') { const click = commandClick(access?(kind==='control'||kind==='input'):a.action_detail?.kind !== 'run' && action.command, armed, Date.now()); setArmed(click.armedUntil); if (!click.decide) return; }
  locked.current = true; setSending(true); try { if(access)await decide(a,status,Math.min(minutes,cap));else await decide(a,status); } finally { locked.current = false; setSending(false); setArmed(0); }
 }
 const secondsLeft = Math.max(0, Math.ceil((Date.parse(a.expires_at || '') - now) / 1000));
 const detail = a.action_detail?.kind === 'run' && run ? run.prompt : action.text;
 return <article className="approval-card" data-approval-id={a.id}>{access&&<><h3>{kind==='input'?'Approve input step':`${kind} access`}</h3><p className="plain">{String(a.action_detail?.reason||a.action_summary)}</p>{grant&&cap<1&&<p>Not enabled on {nodes.find(n=>n.id===a.node_id)?.name}; turn it on at that machine.</p>}{grant&&<label>Grant duration<select aria-label="Grant duration" disabled={sending||armed>now} value={Math.min(minutes,cap)} onChange={e=>{setMinutes(Number(e.target.value));setArmed(0);}}>{Array.from({length:Math.max(0,cap)},(_,i)=>i+1).map(m=><option key={m} value={m}>{m} min</option>)}</select></label>}</>}<strong>{run?.executor || String(a.action_detail?.executor || 'Agent')} · {node?.name || 'Unknown machine'}</strong>{run && <p>Folder: {run.folder_alias} · Lease: {run.lease_minutes} min</p>}<div className="approval-detail"><p className={`plain ${expanded ? '' : 'approval-preview'}`}>{action.command ? <code>{detail}</code> : detail}</p><button type="button" className="detail-toggle" aria-expanded={expanded} onClick={()=>setExpanded(!expanded)}>{expanded ? 'Show less' : 'Show more'}</button></div><p>{pending ? `${Math.floor(secondsLeft / 60)}:${String(secondsLeft % 60).padStart(2, '0')} left` : a.status === 'approved' ? 'Approved' : a.status === 'denied' ? 'Denied' : a.status === 'decided' ? 'Decided elsewhere' : 'Expired'}</p>{pending && (owner ? <div className="row"><button disabled={busy || sending || (access&&cap<1)} onClick={() => void send('approved').catch(()=>{})}>{armed > now ? access?'Confirm access?':'Approve command?' : 'Approve'}</button><button disabled={busy || sending} onClick={() => void send('denied').catch(()=>{})}>Deny</button></div> : <p>Waiting for {node?.name || 'machine'} owner</p>)}</article>;
}
