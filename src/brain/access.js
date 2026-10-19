import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createSdkMcpServer,tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { createMirrorClient } from '../bitos/client.js';
import { checked } from './chatTasks.js';
export function accessTools(access,scope) {
 return createSdkMcpServer({name:'access',version:'1.0.0',tools:[tool('request_access','Request owner screen/control access for this conversation. Creates a pending card only; never grants permission. State the exact plan in reason. Input still requires one owner approval per step.',{machine:z.string().min(1).max(64),kind:z.enum(['screen','control']),minutes:z.number().int().min(1).max(15),reason:z.string().min(1).max(1000)},input=>access.request(scope,input))]});
}
export function startAccess({root,env={},hub,runner,makeClient=createMirrorClient,now=Date.now,pollMs=1000,log=console.warn}={}) {
 if(env.BITOS_SUPABASE!=='1'||env.BITOS_DASHBOARD_CHAT!=='1')return null;
 const owner=env.BITOS_OWNER_USER_ID,active=new Map(),waiters=new Map(),blocked=new Set(),stopping=new Set();let afterGranted=()=>{};let db,channel,timer,closed=false,chain=Promise.resolve();
 const tainted=key=>blocked.has(key)||Boolean(runner.web?.session(runner.webKeys?.[key]||runner.sessions?.[key]||key).tainted);
 const iso=()=>new Date(now()).toISOString();
 const warn=()=>log('Dashboard access unavailable; check migration 0009 and node opt-in.');
 async function convo(id,workspace){const c=(await checked(db.from('conversations').select('*').eq('id',id).eq('workspace_id',workspace).eq('owner_id',owner)))[0];if(!c)return;const members=await checked(db.from('workspace_members').select('role').eq('workspace_id',workspace).eq('user_id',owner));return members.length?c:undefined;}
 async function node(id){return (await checked(db.from('nodes').select('*').eq('id',id).eq('owner_id',owner)))[0];}
 function live(name){return hub.list().find(n=>n.online&&n.machine.toLowerCase()===name.toLowerCase());}
 async function policy(n){const machine=live(n.name);if(!machine)throw Error('Machine is offline');const p=await hub.request(n.name,'grants.capabilities');
  if(!Number.isSafeInteger(p.generation)||p.generation<0||typeof p.screen!=='boolean'||typeof p.control!=='boolean'||!Number.isInteger(p.screenMinutes)||p.screenMinutes<1||p.screenMinutes>15||!Number.isInteger(p.controlMinutes)||p.controlMinutes<1||p.controlMinutes>10)throw Error('Invalid node policy');
  if(JSON.stringify(n.metadata?.remote_grants)!==JSON.stringify(p))await checked(db.from('nodes').update({metadata:{...n.metadata,remote_grants:p}}).eq('id',n.id));return {...p,screen:p.screen&&machine.capabilities?.includes('screen'),control:p.control&&machine.capabilities?.includes('input')&&machine.capabilities?.includes('screen')};
 }
 async function record(g,decision){
  const metadata={event:'access',time:iso(),grant_id:g.id,node_id:g.node_id,conversation_id:g.conversation_id,kind:g.kind,decision};
  fs.mkdirSync(path.join(root,'data'),{recursive:true,mode:0o700});fs.appendFileSync(path.join(root,'data/audit.log'),JSON.stringify(metadata)+'\n',{mode:0o600});
  await checked(db.from('task_events').insert({client_event_id:randomUUID(),node_id:g.node_id,kind:'access',summary:`${g.kind} access: ${decision}`,payload:metadata}));
 }
 async function card(r){await checked(db.from('chat_messages').insert({id:randomUUID(),conversation_id:r.conversation_id,workspace_id:r.workspace_id,owner_id:owner,author:'bit',body:r.status==='unavailable'?r.reason:'This needs your decision, Ozzy.',status:'done',cards:[{kind:'access',requestId:r.id}]}));}
 async function makeRequest(scope,input,kind=input.kind,detail={}) {
  if(scope.scheduled||scope.tainted?.()||tainted(scope.channel)||!scope.channel?.startsWith('dash:'))throw Error('Access is unavailable in scheduled or tainted conversations. Start a fresh chat.');
  const id=scope.channel.slice(5),c=await convo(id,scope.workspace);if(!c)throw Error('Conversation unavailable');
  const nodes=await checked(db.from('nodes').select('*').eq('owner_id',owner));const n=nodes.find(n=>n.name.toLowerCase()===input.machine.toLowerCase());if(!n)throw Error('Machine unavailable');
  const p=await policy(n),enabled=p.screen&&(kind==='screen'||p.control),cap=Math.min(15,p.screenMinutes,kind==='screen'?15:Math.min(10,p.controlMinutes));
  if(enabled&&(input.minutes>cap||input.minutes<1||!Number.isInteger(input.minutes)))throw Error(`Choose at most ${cap} minutes for this machine.`);
  const r={id:randomUUID(),workspace_id:c.workspace_id,conversation_id:c.id,owner_id:owner,node_id:n.id,kind,reason:enabled?input.reason:`Not enabled on ${n.name}; turn it on at that machine.`,policy_generation:p.generation,requested_minutes:input.minutes,action_detail:detail,status:enabled?'pending':'unavailable',expires_at:new Date(now()+600000).toISOString()};
  if(scope.tainted?.())throw Error('Conversation became tainted');
  await checked(db.from('access_requests').insert(r));await card(r);await record(r,r.status);return r;
 }
 async function stop(g,reason='owner stop'){
  if(stopping.has(g.id))return;stopping.add(g.id);
  const key=`dash:${g.conversation_id}`,entry=active.get(key);if(entry?.id===g.id)active.delete(key);
  try{
  // Drop brain authority synchronously, before network/database operations.
  if(entry?.id===g.id||runner.screens.state.grants[key]?.id===g.id){runner.screens.off(key);await runner.controls.off(key,reason);}
  const n=entry?{name:entry.machine}:await node(g.node_id);if(n)await hub.request(n.name,'grants.stop',{grantId:g.id,conversationKey:key}).catch(()=>{});
  await checked(db.from('access_grants').update({status:'ended',ended_at:iso(),end_reason:reason}).eq('id',g.id));await record(g,reason);
  }finally{stopping.delete(g.id);}
 }
 async function activate(r){
  if(r.owner_id!==owner||r.decided_by!==owner||!r.decided_at||Date.parse(r.decided_at)>Date.parse(r.expires_at)||now()>=Date.parse(r.expires_at)||tainted(`dash:${r.conversation_id}`))return;
  if(!await convo(r.conversation_id,r.workspace_id))return;const n=await node(r.node_id);if(!n)return;
  const p=await policy(n),minutes=r.granted_minutes,cap=Math.min(r.requested_minutes,15,p.screenMinutes,r.kind==='screen'?15:Math.min(10,p.controlMinutes));
  if(r.policy_generation!==p.generation||!p.screen||(r.kind==='control'&&!p.control)||!Number.isInteger(minutes)||minutes<1||minutes>cap)return;
  const prior=await checked(db.from('access_grants').select('id').eq('request_id',r.id));if(prior.length)return; // Seeded/restored rows never confer runtime authority.
  const key=`dash:${r.conversation_id}`,g={id:r.id,request_id:r.id,workspace_id:r.workspace_id,conversation_id:r.conversation_id,owner_id:owner,node_id:n.id,kind:r.kind,status:'starting',issued_at:iso(),expires_at:new Date(now()+minutes*60000).toISOString(),stop_requested:false};
  await checked(db.from('access_grants').insert(g));
  try {
   const existing=active.get(key);if(existing)await stop(existing,'replaced');
   if(tainted(key))throw Error('Conversation tainted');
   runner.screens.on(key,n.name,{id:g.id,expiresAt:g.expires_at,kind:g.kind,policyGeneration:p.generation});
   await runner.screens.ensureNode(key,hub);
   if(g.kind==='control')await runner.controls.on(key,n.name);
   const current=(await checked(db.from('access_grants').select('*').eq('id',g.id)))[0];
   if(closed||current.stop_requested||tainted(key))throw Error('Grant cancelled during start');
   const checkedRequest=(await checked(db.from('access_requests').select('*').eq('id',r.id)))[0];if(checkedRequest.status!=='approved'||checkedRequest.decided_by!==owner)throw Error('Approval changed');
   const claimed=await checked(db.from('access_grants').update({status:'active'}).eq('id',g.id).eq('status','starting').eq('stop_requested',false).select('id'));if(!claimed.length)throw Error('Grant stopped during activation');
   active.set(key,{...g,status:'active',machine:n.name,controlId:runner.controls.active(key)?.id});await record(g,'started');runner.presence?.observe('leaseStarted',{...runner.screens.grant(key),level:'watch'});if(g.kind==='control')runner.presence?.observe('leaseStarted',{...runner.controls.grant(key),level:'control'});void Promise.resolve(afterGranted(g,r)).catch(warn);
  }catch{await stop(g,'activation failed');runner.screens.off(key);await runner.controls.off(key,'activation failed');}
 }
 async function scan(){
  if(closed)return;
  for(const n of await checked(db.from('nodes').select('*').eq('owner_id',owner)))if(live(n.name))try{await policy(n);}catch{}
  for(const g of await checked(db.from('access_grants').select('*').eq('owner_id',owner).in('status',['starting','active']))) {
   const entry=active.get(`dash:${g.conversation_id}`);
   if(!await convo(g.conversation_id,g.workspace_id)){await stop(g,'conversation permission removed');continue;}
   if(g.stop_requested||now()>=Date.parse(g.expires_at)||!entry)await stop(g,g.stop_requested?'owner stop':now()>=Date.parse(g.expires_at)?'expired':'brain restarted');
  }
  for(const r of await checked(db.from('access_requests').select('*').eq('owner_id',owner).in('status',['pending','approved','denied']))) {
   if(r.status==='pending'&&now()>=Date.parse(r.expires_at)){await checked(db.from('access_requests').update({status:'expired'}).eq('id',r.id));const resolve=waiters.get(r.id);resolve?.(false);waiters.delete(r.id);continue;}
   if(r.kind==='input') {
    if(r.status!=='pending'&&waiters.has(r.id)){const entry=active.get(`dash:${r.conversation_id}`);await record(r,`input ${r.status}`);waiters.get(r.id)(r.status==='approved'&&r.decided_by===owner&&Date.parse(r.decided_at)<=Date.parse(r.expires_at)&&now()<Date.parse(r.expires_at)&&entry?.id===r.action_detail.grant_id&&!tainted(`dash:${r.conversation_id}`));waiters.delete(r.id);}continue;
   }
   if(r.status==='approved')await activate(r);
   // Manual machine-card requests arrive via RLS. The brain validates policy and
   // posts a card once; model requests already posted their own card.
   if(r.status==='pending') {const n=await node(r.node_id);if(n){const p=await policy(n);if(!p.screen||(r.kind==='control'&&!p.control)){await checked(db.from('access_requests').update({status:'unavailable',reason:`Not enabled on ${n.name}; turn it on at that machine.`}).eq('id',r.id));}}}
  }
 }
 function schedule(){chain=chain.then(scan).catch(warn);return chain;}
 const controlClosed=({grantId,machine,reason})=>{for(const g of active.values())if(g.controlId===grantId&&g.machine.toLowerCase()===String(machine).toLowerCase())void stop(g,reason||'control ended').catch(warn);};hub.on('control_closed',controlClosed);
 const ready=(async()=>{db=await makeClient(env);channel=db.channel('dashboard-access').on('postgres_changes',{event:'*',schema:'public',table:'access_requests'},schedule).on('postgres_changes',{event:'*',schema:'public',table:'access_grants'},event=>{const row=event.new;if(row?.stop_requested===true&&row.owner_id===owner){const g=[...active.values()].find(g=>g.id===row.id);if(g)return stop(g,'owner stop').catch(warn);}return schedule();}).subscribe();await scan();timer=setInterval(schedule,pollMs);timer.unref();})();
 const localClosed=({grantId,reason,machine,conversationKey})=>{for(const g of active.values())if(g.id===grantId&&g.machine.toLowerCase()===String(machine).toLowerCase()&&conversationKey===`dash:${g.conversation_id}`)void stop(g,reason||'node ended grant').catch(warn);};hub.on('access_closed',localClosed);
 return {ready,
  set onGranted(fn){afterGranted=fn;},
  async request(scope,input){try{await ready;const r=await makeRequest(scope,input);return {content:[{type:'text',text:r.status==='pending'?'Request card created. No access granted yet.':r.reason}]};}catch(error){return {isError:true,content:[{type:'text',text:error.message}]};}},
  async confirm(key){await ready;const g=active.get(key);if(!g||tainted(key)||now()>=Date.parse(g.expires_at))return null;
   const rows=await checked(db.from('access_grants').select('*').eq('id',g.id).eq('status','active').eq('stop_requested',false));const r=(await checked(db.from('access_requests').select('*').eq('id',g.request_id).eq('status','approved').eq('decided_by',owner)))[0];
   if(!await convo(g.conversation_id,g.workspace_id)||!await node(g.node_id)||!rows.length||!r||rows[0].conversation_id!==g.conversation_id||rows[0].node_id!==g.node_id||rows[0].owner_id!==owner||rows[0].kind!==g.kind||Date.parse(rows[0].expires_at)!==Date.parse(g.expires_at)||r.conversation_id!==g.conversation_id||r.node_id!==g.node_id||r.owner_id!==owner||r.kind!==g.kind||tainted(key))return null;
   try{const result=await hub.request(g.machine,'grants.check',{grantId:g.id,conversationKey:key});return result.active?g:null;}catch{await stop(g,'node grant unavailable');return null;}
  },
  async used(key,decision='capture'){const g=active.get(key);if(g)await record(g,decision);},
  isActive(key,machine){const g=active.get(key);return !!g&&!tainted(key)&&g.machine.toLowerCase()===machine.toLowerCase()&&now()<Date.parse(g.expires_at);},
  async approve(key,request){await ready;const g=active.get(key);if(!g||g.kind!=='control'||tainted(key))return false;
   const r=await makeRequest({channel:key,workspace:g.workspace_id,tainted:()=>tainted(key)},{machine:g.machine,kind:'input',minutes:1,reason:request.description||'Computer input step'},'input',{grant_id:g.id,tool:request.tool,action:request.input?.action,input:request.input});
   if(r.status!=='pending')return false;
   return new Promise(resolve=>{const timer=setTimeout(()=>{waiters.delete(r.id);resolve(false);},600000);timer.unref();const cancel=()=>{clearTimeout(timer);waiters.delete(r.id);resolve(false);};request.signal?.addEventListener('abort',cancel,{once:true});const finish=allowed=>{clearTimeout(timer);request.signal?.removeEventListener('abort',cancel);resolve(allowed);};finish.channel=key;waiters.set(r.id,finish);if(request.signal?.aborted)cancel();});
  },
  async taint(key){blocked.add(key);const g=active.get(key);if(g)await stop(g,'conversation tainted');for(const [id,resolve]of waiters)if(resolve.channel===key){resolve(false);waiters.delete(id);}runner.screens.off(key);await runner.controls.off(key,'conversation tainted');},
  scan:schedule,
  close(){closed=true;clearInterval(timer);hub.off('access_closed',localClosed);hub.off('control_closed',controlClosed);for(const resolve of waiters.values())resolve(false);waiters.clear();for(const g of active.values())void stop(g,'brain shutdown').catch(warn);if(channel)void db.removeChannel(channel);},
 };
}
