import { createRoot } from 'react-dom/client';
import { useState } from 'react';
import { BitPresence } from '../../src/BitPresence';
import { Approvals } from '../../src/Approvals';
import type { Approval, Node, Run } from '../../src/model';
import '../../src/style.css';
const start = Date.now();
const initial: Approval[] = Array.from({length:80}, (_,i)=>({id:String(i),node_id:'mac',action_summary:`Approval ${i+1}: visible scrolling content`,risk:'risky',requested_at:new Date(start).toISOString(),expires_at:new Date(start+3600000+i*1000).toISOString(),status:'pending',action_detail:{run_id:'run'}}));
const nodes: Node[] = [{id:'mac',name:'MacBook',owner_id:'owner',os:'macOS',capabilities:[],status:'online',last_seen_at:null}];
const runs: Run[] = [{id:'run',task_id:'task',node_id:'mac',executor:'codex',folder_alias:'ozzy-os',lease_minutes:20,prompt:'QA task',status:'running',stop_requested:false,branch:null,summary:null,created_at:new Date(start).toISOString()}];
function Fixture(){
 const [approvals,setApprovals]=useState(initial),[now,setNow]=useState(start);
 const decide=async(a:Approval,status:'approved'|'denied')=>{(window as any).decisions.push({id:a.id,status});setApprovals(items=>items.map(item=>item.id===a.id?{...item,status}:item));};
 (window as any).decisions ||= [];
 (window as any).qa = { remote:(id:string,status:string)=>setApprovals(items=>items.map(a=>a.id===id?{...a,status}:a)), remove:(id:string)=>setApprovals(items=>items.filter(a=>a.id!==id)), advance:(ms:number)=>setNow(start+ms), command:()=>setApprovals([{...initial[0],action_summary:'Run shell command',action_detail:{tool:'Bash',command:'git status',run_id:'run'}}]) };
 const props={approvals,nodes,runs,now,user:'owner',decide};
 return <><header><div><span className="eyebrow">OZZY / OPERATING SYSTEM</span><h1>bIT OS <small>Dashboard</small></h1></div><div className="toolbar"><BitPresence {...props}/><label>Workspace<select><option>QA workspace</option></select></label><button>Refresh</button><button>Sign out</button></div></header><main style={{minHeight:3000}}><h2>Workspace overview</h2><p>Deterministic panel fixture. No account or network access required.</p><button>Outside control</button><Approvals {...props}/></main></>;
}
createRoot(document.getElementById('root')!).render(<Fixture/>);
