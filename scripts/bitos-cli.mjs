import fs from 'node:fs';
import readline from 'node:readline/promises';
import { parseArgs } from 'node:util';
import { randomUUID } from 'node:crypto';
import dotenv from 'dotenv';
import { createClient } from '@supabase/supabase-js';

// Deliberately do not load process environment or any brain settings.
const config = dotenv.parse(fs.readFileSync(new URL('../apps/dashboard/.env.local',import.meta.url)));
const db = createClient(config.VITE_SUPABASE_URL,config.VITE_SUPABASE_PUBLISHABLE_KEY,{auth:{persistSession:false,autoRefreshToken:false}});
const terminal = readline.createInterface({input:process.stdin,output:process.stdout});
async function query(q) {const r=await q;if(r.error)throw Error(r.error.message);return r.data;}
async function password() {
  if (!process.stdin.isTTY) throw Error('Use an interactive terminal for password entry');
  const output = terminal._writeToOutput;
  process.stdout.write('Password: ');
  terminal._writeToOutput = () => {};
  try {return await terminal.question('');} finally {terminal._writeToOutput=output;process.stdout.write('\n');}
}
try {
 const email=await terminal.question('Email: '), pass=await password();
 const {data,error}=await db.auth.signInWithPassword({email,password:pass});if(error)throw error;
 const user=data.user.id;
 const {positionals,values}=parseArgs({allowPositionals:true,options:Object.fromEntries(['node','executor','folder','lease','prompt'].map(k=>[k,{type:'string'}]))});
 const [command,id]=positionals;
 if(command==='run') {
  const nodes=await query(db.from('nodes').select('*'));const node=nodes.find(n=>n.name.toLowerCase()===values.node?.toLowerCase());if(!node)throw Error('Visible node not found');
  const members=await query(db.from('workspace_members').select('*').eq('user_id',user));
  const choices=members.filter(m=>m.role!=='viewer');if(!choices.length)throw Error('No member workspace');
  let ws=choices[0].workspace_id;
  if(choices.length>1){console.log(choices.map(m=>m.workspace_id).join('\n'));ws=await terminal.question('Workspace UUID: ');if(!choices.some(m=>m.workspace_id===ws))throw Error('Invalid workspace');}
  const taskId=randomUUID(),runId=randomUUID();
  await query(db.from('tasks').insert({id:taskId,workspace_id:ws,title:`Run ${values.executor} on ${node.name}`,status:'inbox',executor:values.executor,node_id:node.id,created_by:user}));
  await query(db.from('agent_runs').insert({id:runId,task_id:taskId,node_id:node.id,executor:values.executor,folder_alias:values.folder,prompt:values.prompt,lease_minutes:Number(values.lease||5),status:'requested',requested_by:user}));console.log(runId);
 } else if(command==='approvals') {
  for(const a of await query(db.from('approvals').select('*').eq('status','pending'))){const answer=await terminal.question(`${a.id}: ${a.action_summary}\nApprove? [y/N] `);await query(db.from('approvals').update({status:/^y$/i.test(answer.trim())?'approved':'denied',decided_by:user,decided_at:new Date().toISOString()}).eq('id',a.id));}
 } else if(command==='stop') await query(db.from('agent_runs').update({stop_requested:true}).eq('id',id));
 else if(command==='watch') {
  let cursor=0;
  for(;;){const runs=await query(db.from('agent_runs').select('*').eq('id',id));const r=runs[0];if(!r)throw Error('Run not found');
   for(const e of await query(db.from('task_events').select('*').eq('task_id',r.task_id).gt('id',cursor).order('id'))){console.log(`${e.created_at} ${e.summary}`);cursor=e.id;}
   if(['done','failed','stopped','expired','denied'].includes(r.status)){console.log(`${r.status}: ${r.summary||''}`);break;}await new Promise(resolve=>setTimeout(resolve,1500));}
 } else throw Error('Expected run, approvals, stop <runId>, or watch <runId>');
} catch(e){console.error(e.message);process.exitCode=1;} finally{await db.auth.signOut();terminal.close();}
