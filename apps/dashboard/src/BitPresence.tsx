import { Chat } from './Chat';
import { BitPanel } from './BitPanel';
import { useCallback, useEffect, useRef, useState } from 'react';
import { supabase } from './client';
import { ApprovalCard } from './ApprovalCard';
import { canStop, isPending, type Task, type Approval, type Node, type Run } from './model';
import '../../../shared/bit-orb/src/bit-orb.js';
export type Presence = { state: string; mood: string; reaction: { kind: string; at: string } | null; node: string | null; lease: { node: string; endsAt: string; totalSec: number } | null; watching: string[]; attention: string; updatedAt?: string; screenGrants?: string[]; capturePulse?: {node: string; at: string} | null };
const offline: Presence = { state:'offline',mood:'chill',reaction:null,node:null,lease:null,watching:[],attention:'ambient' };
export function Orb({ presence, size = 48 }: { presence: Presence; size?: number }) {
 const ref = useRef<HTMLElement & { presence?: Presence }>(null);
 useEffect(() => { if(ref.current)ref.current.presence=presence; },[presence]);
 return <bit-orb ref={ref} style={{width:size,height:size}} />;
}
const words: Record<string,string> = { idle:'Idle',listen:'Listening',think:'Thinking',agent:'Running a task',lease:'Control lease',screen:'Watching screen',approve:'Needs approval',offline:'Offline' };
export function BitPresence({ approvals, now, nodes = [], runs = [], user = '', busy = false, error = '', tasks = [], stop, viewLog, workspace, viewTask, decide = async () => {} }: { approvals: Approval[]; now: number; tasks?: Task[]; workspace?: string; viewTask?: (task:Task)=>void; stop?: (run: Run) => Promise<void>; viewLog?: (task: Task) => void; nodes?: Node[]; runs?: Run[]; user?: string; busy?: boolean; error?: string; decide?: (a: Approval, status: 'approved' | 'denied') => Promise<void> }) {
 const [presence,setPresence]=useState<Presence>(offline),[open,setOpen]=useState(false);
 const trigger = useRef<HTMLButtonElement>(null);
 const close = useCallback(() => setOpen(false), []);
 useEffect(()=>{
  if(!supabase)return;
  const client=supabase;let active=true,revision=0;
  const load=async()=>{const request=++revision;const result=await client.from('bit_presence').select('presence').eq('id','ozzy').maybeSingle();if(active&&request===revision&&!result.error)setPresence(result.data?.presence||offline);};
  const channel=client.channel('bit-presence').on('postgres_changes',{event:'*',schema:'public',table:'bit_presence',filter:'id=eq.ozzy'},()=>void load()).subscribe(status=>{if(status==='SUBSCRIBED')void load();});void load();
  return()=>{active=false;void client.removeChannel(channel);};
 },[]);
 const pending = approvals.filter(a => isPending(a, now)).sort((a,b) => Date.parse(a.expires_at!) - Date.parse(b.expires_at!));
 const previous = useRef<Approval[]>([]);
 const [finished, setFinished] = useState<{a: Approval; until: number}[]>([]);
 useEffect(() => {
  const removed = previous.current.filter(a => !approvals.some(next => next.id === a.id && isPending(next, now)));
  previous.current = approvals.filter(a => isPending(a, now));
  setFinished(items => [
   ...items.filter(item => item.until > now),
   ...removed.map(a => {
    const next = approvals.find(next => next.id === a.id);
    const status = next?.status && next.status !== 'pending' ? next.status : Date.parse(a.expires_at!) <= now ? 'expired' : 'decided';
    return {a: {...a, status}, until: now + 2000};
   }),
  ]);
 }, [approvals, now]);
 const stale=!presence.updatedAt||now-Date.parse(presence.updatedAt)>90000;
 const current=stale?{...presence,state:'offline'}:pending.length?{...presence,state:'approve'}:presence.state === 'approve'?{...presence,state:presence.lease && Date.parse(presence.lease.endsAt)>now?'lease':(presence.screenGrants?.length || presence.watching.length)?'screen':runs.some(r => ['dispatched', 'running'].includes(r.status))?'agent':'idle'}:presence;
 return <div className="bit-presence"><button ref={trigger} type="button" className="orb-button" aria-haspopup="dialog" aria-label="Show bIT presence" aria-expanded={open} onClick={()=>setOpen(!open)}><Orb presence={current}/>{pending.length>0&&<span className="orb-badge" aria-label={`${pending.length} pending approvals`}>{pending.length}</span>}</button>{open&&<BitPanel anchor={trigger} title={`bIT: ${words[current.state]}`} avatar={<Orb presence={current}/>} onClose={close}>{error&&<p role="alert">{error}</p>}{(pending.length>0||finished.length>0)&&<section className="panel-approvals" aria-label="Pending approvals"><h3>Pending approvals ({pending.length})</h3>{pending.map(a=><ApprovalCard key={a.id} {...{a,nodes,runs,user,now,busy,decide}}/>)}<div role="status">{finished.map(({a})=><ApprovalCard key={a.id} {...{a,nodes,runs,user,now,busy,decide}}/>)}</div></section>}<section aria-label="Current activity"><h3>Current activity</h3>{runs.filter(run=>['dispatched','running'].includes(run.status)).map(run=>{const task=tasks.find(task=>task.id===run.task_id), seconds=run.started_at?Math.max(0,Math.floor((now-Date.parse(run.started_at))/1000)):null;return <article key={run.id}><strong>{task?.title || 'Running task'}</strong><p>{nodes.find(node=>node.id===run.node_id)?.name || 'Unknown machine'}{seconds!==null&&<> · running {Math.floor(seconds/60)}:{String(seconds%60).padStart(2,'0')}</>}</p>{task&&viewLog&&<a href={`#task-log-${task.id}`} onClick={event=>{event.preventDefault();close();viewLog(task);}}>View live log</a>}{stop&&canStop(run,nodes,user)&&<button disabled={busy||run.stop_requested} onClick={()=>void stop(run)}>{run.stop_requested?'Stopping…':'Stop'}</button>}</article>})}{stale?<p>Waiting for the brain to reconnect.</p>:<>{current.node&&<p>On {current.node}</p>}{current.lease&&Date.parse(current.lease.endsAt)>now&&<p>Control lease on {current.lease.node}: {Math.ceil((Date.parse(current.lease.endsAt)-now)/1000)}s left</p>}{(current.screenGrants || []).length>0&&<p>Screen access active: {current.screenGrants!.join(', ')}</p>}{current.watching.length>0&&<p>Watching {current.watching.join(', ')}</p>}</>}</section>{workspace&&user&&<Chat {...{workspace,user,nodes,runs,now,busy,decide}} viewTask={task=>{close();viewTask?.(task);}}/>}</BitPanel>}</div>;
}
export function BitLab() {
 const [state,setState]=useState('idle'),[mood,setMood]=useState('chill'),[reaction,setReaction]=useState<Presence['reaction']>(null),[size,setSize]=useState(284);
 const [capturePulse,setCapturePulse]=useState<Presence['capturePulse']>(null);
 const presence:Presence={state,mood,reaction,capturePulse,node:state==='screen'?'OZZY-AI':'MacBook',lease:{node:'MacBook',endsAt:new Date(Date.now()+1200000).toISOString(),totalSec:1200},watching:state==='screen'?['OZZY-AI']:[],attention:'ambient'};
 return <main><h1>bIT lab</h1><div className="lab-preview"><Orb presence={presence} size={size}/><Orb presence={presence} size={28}/></div>{[['State',Object.keys(words),setState],['Mood',['chill','hype','chaotic','gremlin','sage'],setMood]].map(([label,keys,set])=><div key={String(label)}><h2>{String(label)}</h2>{(keys as string[]).map(key=><button key={key} onClick={()=> (set as (v:string)=>void)(key)}>{key}</button>)}</div>)}<h2>Reaction</h2>{['celebrate','wince','curious','unsure'].map(kind=><button key={kind} onClick={()=>setReaction({kind,at:new Date().toISOString()})}>{kind}</button>)}<button onClick={()=>setCapturePulse({node:'OZZY-AI',at:new Date().toISOString()})}>Capture scan pulse</button><h2>Size</h2>{[28,39,40,48,64,95,96,284].map(n=><button key={n} onClick={()=>setSize(n)}>{n}px</button>)}<h2>Unmodified reference</h2><iframe title="bIT visual reference" src="/bit-reference.html" style={{width:'100%',height:650,border:0}}/></main>;
}
