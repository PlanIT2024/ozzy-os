// Imported with Runner only, after the brain scrubs service-role settings.
import { z } from 'zod';
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { createFields, taskSchemas } from './chatTasks.js';
export function taskTools(actions) {
 const schemas={create_task:{title:createFields.shape.title.optional(),description:createFields.shape.description,project:createFields.shape.project,due:createFields.shape.due,node:createFields.shape.node,tasks:z.array(createFields).min(1).max(20).optional()},update_task:taskSchemas.update_task.shape,list_tasks:taskSchemas.list_tasks.shape};
 return createSdkMcpServer({name:'tasks',version:'1.0.0',tools:Object.keys(schemas).map(name=>tool(name, name==='create_task'?'Create one inbox task or a tasks array of up to 20 in this conversation workspace.':name==='update_task'?'Update a task in this conversation workspace. No approval decisions.':'Read tasks in this conversation workspace.', schemas[name],async input=>{try{return {content:[{type:'text',text:JSON.stringify(await actions[name](input))}]};}catch(error){return {isError:true,content:[{type:'text',text:error.message}]};}}))});
}
