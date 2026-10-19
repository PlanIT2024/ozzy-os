import path from 'node:path';
import { createHash } from 'node:crypto';
import { readJSON, saveJSON, serial } from '../shared.js';
import { createMirrorClient } from '../bitos/client.js';
import { checked, createTaskActions } from './chatTasks.js';
export function replyId(id, kind='reply') {
 const h=createHash('sha256').update(`${kind}:${id}`).digest('hex');
 return `${h.slice(0,8)}-${h.slice(8,12)}-5${h.slice(13,16)}-a${h.slice(17,20)}-${h.slice(20,32)}`;
}
export function replyWriter({write,now=Date.now,sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms))}) {
 let last=now(),body='',cards=[];
 const queue=serial(), approvalQueue=serial();
 return {
  publish(text,nextCards) {return queue(async()=>{
   const nextBody=text===undefined?body:text, next=nextCards?[...nextCards]:cards;
   const changed=nextBody!==body || JSON.stringify(next)!==JSON.stringify(cards);
   body=nextBody;cards=next;
   if(changed && now()-last>=750){await write({body,cards,status:'streaming'});last=now();}
  });},
  finish(status,finalBody,finalCards) {return queue(async()=>{
   if(finalBody!==undefined)body=finalBody;if(finalCards)cards=[...finalCards];
   const delay=750-(now()-last);if(delay>0)await sleep(delay);
   await write({body,cards,status});last=now();
  });},
 };
}
export function startDashboardChat({root,env={},runner,presence,makeClient=createMirrorClient,now=Date.now,sleep,log=console.warn}={}) {
 if(env.BITOS_SUPABASE!=='1'||env.BITOS_DASHBOARD_CHAT!=='1')return {ready:Promise.resolve(),close(){}};
 const owner=env.BITOS_OWNER_USER_ID;
 if(!owner)throw new Error('Dashboard chat requires BITOS_OWNER_USER_ID');
 const file=path.join(root,'data/dashboard-chat-processed.json'), ledger=readJSON(file,{}), queue=serial(), approvalQueue=serial();
 let db,channel,closed=false;
 const iso=()=>new Date(now()).toISOString();
 const safeLog=()=>log('Dashboard chat database operation failed; check migration 0007 and connectivity.');
 const persist=()=>saveJSON(file,ledger);
 async function conversation(id,workspace) {
  const rows=await checked(db.from('conversations').select('*').eq('owner_id',owner).eq('workspace_id',workspace).eq('id',id));return rows[0];
 }
 async function validMessage(row) {
  if(row.author!=='owner'||row.owner_id!==owner)return false;
  if(!await conversation(row.conversation_id,row.workspace_id))return false;
  const members=await checked(db.from('workspace_members').select('role').eq('workspace_id',row.workspace_id).eq('user_id',owner));return !!members.length;
 }
 async function approvalCards(workspace) {
  const tasks=await checked(db.from('tasks').select('id').eq('workspace_id',workspace));if(!tasks.length)return [];
  const rows=await checked(db.from('approvals').select('id,expires_at').in('task_id',tasks.map(t=>t.id)).eq('status','pending').gt('expires_at',iso()));
  return rows.map(a=>({kind:'approval',approvalId:a.id}));
 }
 async function processRow(row) {
  if(closed||!await validMessage(row))return;
  if(ledger[row.id]?.status==='done')return;
  const id=replyId(row.id), binding={id,conversation_id:row.conversation_id,workspace_id:row.workspace_id,owner_id:owner,author:'bit'};
  const existing=await checked(db.from('chat_messages').select('id,status').eq('id',id));
  if(ledger[row.id] || existing.length) {
   // An interrupted claim is never replayed through the model or its task tools.
   if(!existing.length)await checked(db.from('chat_messages').insert({...binding,body:'My ring restarted mid-thought. Please send a new message to continue.',cards:null,status:'error'}));
   else if(existing[0].status==='streaming')await checked(db.from('chat_messages').update({status:'error'}).eq('id',id));
   ledger[row.id]={status:'done'};persist();return;
  }
  ledger[row.id]={status:'working'};persist();
  let inserted=false, failed=false, writer;
  try {
   await checked(db.from('chat_messages').insert({...binding,body:'',cards:null,status:'streaming'}));inserted=true;
   writer=replyWriter({write:patch=>checked(db.from('chat_messages').update(patch).eq('id',id)),now,sleep});
   const cards=[];
   const tasks=createTaskActions({db,owner,workspace:row.workspace_id,conversation:row.conversation_id,onCard:async card=>{cards.push(card);await writer.publish(undefined,cards);}});
   presence?.react('curious');presence?.set({listening:1});
   await Promise.resolve();presence?.set({listening:0,thinking:1});
   const waiting=await approvalCards(row.workspace_id);
   let response;
   if(waiting.length && /^\s*(approve|approved|yes|do it)[.!\s]*$/i.test(row.body)) {
    cards.push(...waiting);response='Tap Approve or Deny on the card, Ozzy. Chat words never decide an approval.';
   } else response=await runner.run(`dash:${row.conversation_id}`,row.body,{tasks,output:body=>writer.publish(body,cards),onError:()=>{failed=true;},approve:async()=>false,notify:async()=>{},webAllowed:true});
   await writer.finish(failed?'error':'done',failed?'My ring hit a snag. Please try a smaller request.':response,cards);
   await checked(db.from('conversations').update({updated_at:iso()}).eq('id',row.conversation_id).eq('owner_id',owner).eq('workspace_id',row.workspace_id));
   ledger[row.id]={status:'done'};persist();
  } catch {
   safeLog();
   if(inserted&&writer)await writer.finish('error','My ring hit a snag. Please try a smaller request.');
   // Keep failed claims durable; recovery repairs the single deterministic reply.
  } finally {presence?.set({listening:0,thinking:0});}
 }
 async function postApprovals() {
  if(closed)return;
  const conversations=await checked(db.from('conversations').select('*').eq('owner_id',owner).order('updated_at',{ascending:false}));
  const seen=new Set();
  for(const convo of conversations) {
   if(seen.has(convo.workspace_id))continue;seen.add(convo.workspace_id);
   const membership=await checked(db.from('workspace_members').select('role').eq('workspace_id',convo.workspace_id).eq('user_id',owner));if(!membership.length)continue;
   const cards=await approvalCards(convo.workspace_id);
   for(const card of cards) {
    const id=replyId(card.approvalId,'approval');
    const prior=await checked(db.from('chat_messages').select('id').eq('id',id));if(prior.length)continue;
    await checked(db.from('chat_messages').insert({id,conversation_id:convo.id,workspace_id:convo.workspace_id,owner_id:owner,author:'bit',body:'This needs your decision, Ozzy.',cards:[card],status:'done'}));
   }
  }
 }
 async function scan() {
  if(closed)return;
  const rows=await checked(db.from('chat_messages').select('*').eq('owner_id',owner).eq('author','owner').gte('created_at',new Date(now()-600000).toISOString()).order('created_at').order('id'));
  for(const row of rows)await processRow(row);
  await approvalQueue(postApprovals);
 }
 const schedule=fn=>queue(()=>closed?undefined:fn()).catch(safeLog);
 const ready=(async()=>{
  db=await makeClient(env);
  // Repair older interrupted claims too, without treating them as new turns.
  for(const [id,claim] of Object.entries(ledger)) if(claim.status==='working') {
   const rows=await checked(db.from('chat_messages').select('*').eq('id',id).eq('owner_id',owner).eq('author','owner'));
   if(rows[0])await processRow(rows[0]);
  }
  channel=db.channel('dashboard-chat').on('postgres_changes',{event:'INSERT',schema:'public',table:'chat_messages',filter:`owner_id=eq.${owner}`},event=>{
   if(event.new?.author==='owner'&&event.new?.owner_id===owner)void schedule(async()=>{
    // Re-fetch the authoritative row instead of trusting a notification payload.
    const rows=await checked(db.from('chat_messages').select('*').eq('id',event.new.id).eq('owner_id',owner).eq('author','owner'));if(rows[0])await processRow(rows[0]);
   });
  }).on('postgres_changes',{event:'INSERT',schema:'public',table:'conversations',filter:`owner_id=eq.${owner}`},()=>void approvalQueue(()=>closed?undefined:postApprovals()).catch(safeLog)).on('postgres_changes',{event:'*',schema:'public',table:'approvals'},()=>void approvalQueue(()=>closed?undefined:postApprovals()).catch(safeLog)).subscribe(status=>{if(status==='SUBSCRIBED')void schedule(scan);});
  await schedule(scan);
 })();
 return {ready,scan:()=>ready.then(()=>schedule(scan)),drain:async()=>{await queue(()=>{});await approvalQueue(()=>{});},close(){closed=true;if(channel)void db.removeChannel(channel);}};
}
