import { useEffect, useRef, useState, lazy, Suspense, type FormEvent, type ReactNode } from 'react';
import { supabase } from './client';
const Access=lazy(()=>import('./Access').then(module=>({default:module.Access})));
import { ApprovalCard } from './ApprovalCard';
import type { Approval, Node, Run, Task } from './model';
const MessageMarkdown=lazy(()=>import('./MessageMarkdown').then(module=>({default:module.MessageMarkdown})));
type Conversation = {id:string; title:string; title_set_by_owner:boolean};
export type TaskCard = {kind:'task'; taskId:string; workspaceId:string; title:string; status:string; project:string|null; created:boolean; before:Record<string,unknown>; changed:Record<string,unknown>; updatedAt:string};
type Card = TaskCard | {kind:'approval'; approvalId:string};
type Message = {id:string;author:'owner'|'bit';body:string;cards:Card[]|null;status:string};
export function Chat({workspace,user,nodes,runs,now,busy,decide,viewTask,context}: {context?:ReactNode;workspace:string;user:string;nodes:Node[];runs:Run[];now:number;busy:boolean;decide:(a:Approval,status:'approved'|'denied')=>Promise<void>;viewTask?:(task:Task)=>void}) {
 const [conversations,setConversations]=useState<Conversation[]>([]),[selected,setSelected]=useState(''),[messages,setMessages]=useState<Message[]>([]),[approvals,setApprovals]=useState<Approval[]>([]),[body,setBody]=useState(''),[sending,setSending]=useState(false),[error,setError]=useState('');
 const [loaded,setLoaded]=useState(false);
 const [renaming,setRenaming]=useState(false),[title,setTitle]=useState('');
 const selection=useRef<string|null>(null);
 const locked=useRef(false), follow=useRef(true), list=useRef<HTMLDivElement>(null);
 const [revision,setRevision]=useState(0);
 useEffect(()=>{
  if(!supabase)return;const client=supabase;let active=true,version=0;
  const load=async()=>{const request=++version;const result=await client.from('conversations').select('id,title,title_set_by_owner').eq('workspace_id',workspace).eq('owner_id',user).order('updated_at',{ascending:false}).order('id',{ascending:false}).limit(20);if(!active||request!==version)return;if(result.error)setError('Chat unavailable. Check migrations 0007–0008 and reconnect.');else {setLoaded(true);setConversations(result.data);if(selection.current===null){selection.current=result.data[0]?.id||'';setSelected(selection.current || '');}}};
  const channel=client.channel(`conversations:${workspace}:${user}`).on('postgres_changes',{event:'*',schema:'public',table:'conversations',filter:`owner_id=eq.${user}`},()=>void load()).subscribe(status=>{if(status==='SUBSCRIBED')void load();});void load();
  return()=>{active=false;version++;void client.removeChannel(channel);};
 },[workspace,user,revision]);
 useEffect(()=>{
  setMessages([]);setApprovals([]);if(!supabase||!selected)return;const client=supabase;let active=true,version=0;
  const load=async()=>{const request=++version;const result=await client.from('chat_messages').select('*').eq('conversation_id',selected).eq('workspace_id',workspace).eq('owner_id',user).order('created_at',{ascending:false}).order('id',{ascending:false}).limit(200);if(!active||request!==version)return;if(result.error){setError('Chat disconnected. Use Reconnect to try again.');return;}
   const rows=result.data as Message[];const ids=[...new Set(rows.flatMap(m=>Array.isArray(m.cards)?m.cards.filter(c=>c.kind==='approval').map(c=>(c as {approvalId:string}).approvalId):[]))];
   const decisions=ids.length?await client.from('approvals').select('*,tasks!inner(workspace_id)').in('id',ids).eq('tasks.workspace_id',workspace):{data:[],error:null};
   if(!active||request!==version)return;if(decisions.error){setError('Could not refresh approval cards. Reconnect to try again.');return;}setMessages([...rows].reverse());setApprovals(decisions.data as Approval[]);
  };
  const channel=client.channel(`chat:${user}:${selected}`).on('postgres_changes',{event:'*',schema:'public',table:'chat_messages',filter:`conversation_id=eq.${selected}`},()=>void load()).on('postgres_changes',{event:'*',schema:'public',table:'approvals'},()=>void load()).subscribe(status=>{if(status==='SUBSCRIBED')void load();if(['CHANNEL_ERROR','TIMED_OUT'].includes(status))setError('Chat disconnected. Use Reconnect to try again.');});void load();
  return()=>{active=false;version++;void client.removeChannel(channel);};
 },[selected,workspace,user,revision]);
 useEffect(()=>{if(follow.current && list.current)list.current.scrollTop=list.current.scrollHeight;},[messages]);
 async function newConversation() {
  const text='New chat';
  const id=crypto.randomUUID();const result=await supabase!.from('conversations').insert({id,workspace_id:workspace,owner_id:user,title:text,title_set_by_owner:false});if(result.error)throw Error('Could not create conversation');setConversations(items=>[{id,title:text,title_set_by_owner:false},...items]);selection.current=id;setSelected(id);setRenaming(false);setMessages([]);follow.current=true;return id;
 }
 async function send(event:FormEvent) {
  event.preventDefault();if(!loaded||locked.current||busy||!body.trim()||body.length>8000||!supabase)return;
  locked.current=true;setSending(true);setError('');
  try {const id=selected||await newConversation();const result=await supabase.from('chat_messages').insert({id:crypto.randomUUID(),conversation_id:id,workspace_id:workspace,owner_id:user,author:'owner',body:body.trim(),cards:null,status:'pending'});if(result.error)throw Error('Message was not sent. Please retry.');setBody('');follow.current=true;setRevision(value=>value+1);}
  catch(e){setError((e as Error).message);}finally{locked.current=false;setSending(false);}
 }
 async function rename(event:FormEvent) {
  event.preventDefault();if(locked.current||!selected||!title.trim()||Array.from(title.trim()).length>80||!supabase)return;
  locked.current=true;setSending(true);setError('');
  try {
   const result=await supabase.from('conversations').update({title:title.trim(),title_set_by_owner:true}).eq('id',selected).eq('workspace_id',workspace).eq('owner_id',user).select('id').single();
   if(result.error)throw Error('Could not rename conversation. Check migration 0008 and reconnect.');
   setConversations(items=>items.map(c=>c.id===selected?{...c,title:title.trim(),title_set_by_owner:true}:c));setRenaming(false);
  } catch(e){setError((e as Error).message);} finally{locked.current=false;setSending(false);}
 }
 return <section className="dashboard-chat" aria-label="Chat with bIT"><div className="chat-toolbar"><label>Recent conversations<select value={selected} onChange={e=>{selection.current=e.target.value;setSelected(e.target.value);setRenaming(false);follow.current=true;}}>{!selected&&<option value="" disabled>{loaded?'No conversations yet':'Loading conversations…'}</option>}{conversations.map(c=><option key={c.id} value={c.id}>{c.title}</option>)}</select></label><button type="button" aria-label="Rename conversation" disabled={!loaded||!selected||sending||busy} onClick={()=>{setTitle(conversations.find(c=>c.id===selected)?.title||'');setRenaming(true);}}><span aria-hidden="true">✎</span></button><button type="button" disabled={!loaded||sending||busy} onClick={()=>{if(locked.current)return;locked.current=true;setSending(true);void newConversation().catch(()=>setError('Could not create conversation')).finally(()=>{locked.current=false;setSending(false);});}}>New chat</button></div>{renaming&&<form className="chat-rename" onSubmit={event=>void rename(event)}><label>Conversation title<input value={title} maxLength={80} onChange={e=>setTitle(e.target.value)} autoFocus /></label><button disabled={sending||!title.trim()||Array.from(title.trim()).length>80}>Save title</button><button type="button" onClick={()=>setRenaming(false)}>Cancel</button></form>}{error&&<p role="alert">{error} <button type="button" onClick={()=>{setError('');setRevision(value=>value+1);}}>Reconnect</button></p>}
 <div className="chat-messages" ref={list} aria-label="Messages" onScroll={()=>{const el=list.current!;follow.current=el.scrollHeight-el.scrollTop-el.clientHeight<40;}}>{context}{messages.map(message=><article className={`chat-message ${message.author}`} key={message.id}><strong>{message.author==='owner'?'You':'bIT'}</strong><>{message.author==='bit'?<Suspense fallback={<p className="plain">{message.body}</p>}><MessageMarkdown body={message.body}/></Suspense>:<p className="plain">{message.body}</p>}</>{message.status==='error'&&<p>Reply interrupted.</p>}{Array.isArray(message.cards)&&message.cards.map((card,i)=>card.kind==='approval'?(()=>{const a=approvals.find(a=>a.id===card.approvalId);return a?<div key={i}><p>Risk: {a.risk}</p><ApprovalCard {...{a,nodes,runs,user,now,busy,decide}}/></div>:<p key={i}>Approval unavailable.</p>;})():card.kind==='task'?<ChatTaskCard key={`${message.id}:${i}`} {...{card,workspace,viewTask}}/>:null)}</article>)}{!messages.length&&<p>Tell bIT what needs to get done.</p>}{selected&&<Suspense fallback={null}><Access key={selected} conversation={selected} {...{nodes,user,now}}/></Suspense>}</div>
 <div role="status" aria-live="polite" className="sr-only">{messages.filter(m=>m.author==='bit'&&m.status!=='streaming').slice(-1).map(m=>m.body).join('')}</div>
 <form className="chat-composer" onSubmit={event=>void send(event)}><label>Message bIT<textarea value={body} rows={2} maxLength={8000} onChange={e=>setBody(e.target.value)} onKeyDown={e=>{if(e.key==='Enter'&&!e.shiftKey&&!e.nativeEvent.isComposing){e.preventDefault();e.currentTarget.form?.requestSubmit();}}}/></label><button disabled={!loaded||sending||busy||!body.trim()||body.length>8000}>Send</button></form></section>;
}
export function ChatTaskCard({card,workspace,viewTask}:{card:TaskCard;workspace:string;viewTask?:(task:Task)=>void}) {
 const [busy,setBusy]=useState(false),[result,setResult]=useState('');
 const locked=useRef(false);
 async function open(){if(!supabase||!viewTask)return;const r=await supabase.from('tasks').select('*').eq('workspace_id',workspace).eq('id',card.taskId).single();if(r.error)setResult('Task unavailable');else viewTask(r.data as Task);}
 async function undo(){if(locked.current||!supabase||card.workspaceId!==workspace)return;locked.current=true;setBusy(true);try{
  const allowed=['title','description','status','project_id','due_date','node_id'];
  if(Object.keys(card.before).some(key=>!allowed.includes(key)))throw Error('Undo unavailable');
  const patch=card.created?{status:'cancelled'}:card.before;
  const r=await supabase.from('tasks').update(patch).eq('workspace_id',workspace).eq('id',card.taskId).eq('updated_at',card.updatedAt).select('id').single();if(r.error)throw Error('Undo unavailable: permission denied or task changed elsewhere.');setResult('Undone');
 }catch(e){setResult((e as Error).message);}finally{locked.current=false;setBusy(false);}}
 return <article className="chat-task-card"><strong>{card.title}</strong><p>{card.status}{card.project?` · ${card.project}`:''}</p><a href={`#task-${card.taskId}`} onClick={e=>{e.preventDefault();void open();}}>Open task on board</a><button type="button" disabled={busy||result==='Undone'} onClick={()=>void undo()}>Undo</button>{result&&<p role="status">{result}</p>}</article>;
}
