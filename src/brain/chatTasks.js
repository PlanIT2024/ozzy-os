import { randomUUID } from 'node:crypto';
import { z } from 'zod';
const fields = z.object({ title:z.string().trim().min(1).max(500).optional(), description:z.string().max(8000).nullable().optional(), status:z.enum(['inbox','planned','running','waiting_on_you','done','cancelled']).optional(), project:z.string().max(200).nullable().optional(), due:z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(), node:z.string().max(200).nullable().optional() }).strict();
export const createFields = fields.omit({status:true}).extend({title:z.string().trim().min(1).max(500)});
export const taskSchemas = {
 create_task:z.union([createFields, z.object({tasks:z.array(createFields).min(1).max(20)}).strict()]),
 update_task:z.object({taskId:z.string().uuid(),fields:fields.refine(v=>Object.keys(v).length>0,'No fields supplied')}).strict(),
 list_tasks:z.object({status:fields.shape.status,project:fields.shape.project}).strict(),
};
export const TASK_TOOLS = Object.keys(taskSchemas).map(name=>`mcp__tasks__${name}`);
export async function checked(query) { const result=await query; if(result.error)throw new Error('Database operation failed'); return result.data; }
export function createTaskActions({db,owner,workspace,conversation,onCard=()=>{}}) {
 async function role(write=false) {
  const rows=await checked(db.from('workspace_members').select('role').eq('workspace_id',workspace).eq('user_id',owner));
  if(!rows?.length || !['owner','admin','member','viewer'].includes(rows[0].role) || (write && rows[0].role==='viewer'))throw new Error('Workspace permission denied');
 }
 async function project(value) {
  if(value==null)return null;
  const rows=await checked(db.from('projects').select('id,name').eq('workspace_id',workspace));
  const matches=rows.filter(p=>p.id===value || p.name.toLowerCase()===value.toLowerCase());
  if(matches.length!==1)throw new Error('Project missing or ambiguous in this workspace'); return matches[0].id;
 }
 async function node(value) {
  if(value==null)return null;
  const owned=await checked(db.from('nodes').select('id,name').eq('owner_id',owner));
  const shares=await checked(db.from('node_shares').select('node_id').eq('workspace_id',workspace));
  const shared=shares.length?await checked(db.from('nodes').select('id,name').in('id',shares.map(s=>s.node_id))):[];
  const matches=[...new Map([...owned,...shared].map(n=>[n.id,n])).values()].filter(n=>n.id===value||n.name.toLowerCase()===value.toLowerCase());
  if(matches.length!==1)throw new Error('Machine missing or ambiguous');return matches[0].id;
 }
 async function patch(input) {
  const result={};
  for(const key of ['title','description','status'])if(key in input)result[key]=input[key];
  if('project' in input)result.project_id=await project(input.project);
  if('node' in input)result.node_id=await node(input.node);
  if('due' in input){if(input.due && new Date(input.due).toISOString().slice(0,10)!==input.due)throw new Error('Invalid date');result.due_date=input.due;}
  return result;
 }
 async function record(task,before,changed,created) {
  const projects=await checked(db.from('projects').select('id,name').eq('workspace_id',workspace));
  const card={kind:'task',taskId:task.id,workspaceId:workspace,title:task.title,status:task.status,project:projects.find(p=>p.id===task.project_id)?.name||null,created,before,changed,updatedAt:task.updated_at};
  await onCard(card);
  return card;
 }
 const actions={
  async create_task(raw) {
   const input=taskSchemas.create_task.parse(raw);await role(true);
   const proposals=await Promise.all(('tasks' in input?input.tasks:[input]).map(patch));
   const cards=[];
   for(const value of proposals){const [task]=await checked(db.rpc('chat_apply_task',{p_owner:owner,p_workspace:workspace,p_conversation:conversation,p_task:randomUUID(),p_fields:value,p_create:true}));cards.push(await record(task,{},value,true));}
   return cards;
  },
  async update_task(raw) {
   const {taskId,fields}=taskSchemas.update_task.parse(raw);await role(true);
   const [before]=await checked(db.from('tasks').select('*').eq('workspace_id',workspace).eq('id',taskId));if(!before)throw new Error('Task not found in this workspace');
   const changed=await patch(fields), previous=Object.fromEntries(Object.keys(changed).map(k=>[k,before[k]??null]));
   const rows=await checked(db.rpc('chat_apply_task',{p_owner:owner,p_workspace:workspace,p_conversation:conversation,p_task:taskId,p_fields:changed,p_create:false,p_expected:before.updated_at}));
   if(rows.length!==1)throw new Error('Task changed elsewhere; read it again');return record(rows[0],previous,changed,false);
  },
  async list_tasks(raw={}) {
   const input=taskSchemas.list_tasks.parse(raw);await role();let q=db.from('tasks').select('id,title,description,status,project_id,node_id,due_date,updated_at').eq('workspace_id',workspace);
   if(input.status)q=q.eq('status',input.status);if('project' in input){const id=await project(input.project);q=id===null?q.is('project_id',null):q.eq('project_id',id);}
   return checked(q.order('created_at',{ascending:false}).limit(100));
  },
 };
 return actions;
}
