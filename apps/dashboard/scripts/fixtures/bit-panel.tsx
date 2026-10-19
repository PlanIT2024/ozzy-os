import { createRoot } from 'react-dom/client';
import { useState } from 'react';
import { BitPresence } from '../../src/BitPresence';
import { Approvals } from '../../src/Approvals';
import type { Approval, Node, Run, Task } from '../../src/model';
import '../../src/style.css';
const start = Date.now();
const initial: Approval[] = Array.from({length:80}, (_,i)=>({id:String(i),node_id:'mac',action_summary:`Approval ${i+1}: visible scrolling content`,risk:'risky',requested_at:new Date(start).toISOString(),expires_at:new Date(start+3600000+i*1000).toISOString(),status:'pending',action_detail:{run_id:'run'}}));
const nodes: Node[] = [{id:'mac',name:'MacBook',owner_id:'owner',os:'macOS',capabilities:[],status:'online',last_seen_at:null}];
const runs: Run[] = [{id:'run',task_id:'task',node_id:'mac',executor:'codex',folder_alias:'ozzy-os',lease_minutes:20,prompt:'QA task',status:'running',stop_requested:false,branch:null,summary:null,created_at:new Date(start).toISOString(),started_at:new Date(start).toISOString()}];
function Fixture(){
 const [approvals,setApprovals]=useState(initial),[now,setNow]=useState(start),[stopped,setStopped]=useState(false),[started,setStarted]=useState(true),[idle,setIdle]=useState(false);
 const decide=async(a:Approval,status:'approved'|'denied')=>{(window as any).decisions.push({id:a.id,status});setApprovals(items=>items.map(item=>item.id===a.id?{...item,status}:item));const db=(window as any).chatDB;if(db){db.tables.approvals.forEach((item:any)=>{if(item.id===a.id)item.status=status;});db.notify();}};
 (window as any).decisions ||= [];
 (window as any).qa = { remotePolicy:()=>{nodes[0].metadata={remote_grants:{screen:true,control:true,screenMinutes:5,controlMinutes:3}};setNow(Date.now());}, idle:()=>{setIdle(true);setApprovals([]);}, noStart:()=>setStarted(false), longPrompt:()=>setApprovals([{...initial[0],action_detail:{run_id:'run',kind:'run'}}]), remote:(id:string,status:string)=>setApprovals(items=>items.map(a=>a.id===id?{...a,status}:a)), remove:(id:string)=>setApprovals(items=>items.filter(a=>a.id!==id)), advance:(ms:number)=>setNow(start+ms), command:()=>setApprovals([{...initial[0],action_summary:'Run shell command',action_detail:{tool:'Bash',command:'git status',run_id:'run'}}]) };
 const props={workspace:location.search.includes('chat=1')?'ws':undefined,viewTask:(task:Task)=>{(window as any).viewedBoard=task.id;},approvals,nodes,runs:(idle?[]:runs).map(run=>({...run,prompt:Array.from({length:20},(_,i)=>`Prompt line ${i}`).join('\n')+'\nlast prompt line',stop_requested:stopped,started_at:started?run.started_at:null})),tasks:[{id:'task',title:'QA task title'} as Task],stop:async(run:Run)=>{(window as any).stops=[run.id];setStopped(true);},viewLog:(task:Task)=>{(window as any).viewedTask=task.id;},now,user:'owner',decide};
 return <><header><div><span className="eyebrow">OZZY / OPERATING SYSTEM</span><h1>bIT OS <small>Dashboard</small></h1></div><div className="toolbar"><BitPresence {...props}/><label>Workspace<select><option>QA workspace</option></select></label><button>Refresh</button><button>Sign out</button></div></header><main style={{minHeight:3000}}><h2>Workspace overview</h2><p>Deterministic panel fixture. No account or network access required.</p><button>Outside control</button><Approvals {...props}/></main></>;
}
createRoot(document.getElementById('root')!).render(<Fixture/>);
