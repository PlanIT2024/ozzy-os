import { deliveryText, validDelivery } from '../node/input/delivery.js';
import sharp from '../node/screen/sharp.js';
import { randomUUID } from 'node:crypto';
import { normalizePlan } from '../node/input/taskPolicy.js';
import { validateCapture } from '../node/screen/image.js';
import { canonical } from '../../relay/wire.js';
export class ControlTasks {
  constructor(controls){this.controls=controls;this.live=new Map();
    controls.hub?.on?.('control_task_progress',event=>this.progress(event));
    controls.hub?.on?.('control_task_ended',event=>{const t=this.find(event);if(t){t.closed=true;t.reason=event.reason;void t.ui?.finish(this.summary(t));}});
  }
  find(event){return [...this.live.values()].find(t=>t.id===event.taskId&&t.grantId===event.grantId&&canonical(event.machine)===t.machine);}
  summary(t){return `${t.reason==='finished'?'✅':'⏹'} Task ended: ${t.steps}/${t.plan.max_steps} steps. ${t.reason||'finished'}. Actions: ${t.actions.join(', ')||'none'}${t.pendingAction?'; unverified: '+t.pendingAction:''}.` ;}
  progress(event){const t=this.find(event);if(!t)return;t.steps=event.steps;
    const g=this.controls.state.grants[t.thread];if(g?.id===t.grantId){g.count=Math.max(g.count,t.baseCount+t.steps);this.controls.save();}
    if(event.phase==='verified'){t.actions.push(event.action);delete t.pendingAction;if(g?.id===t.grantId){g.actions.push(event.action);delete g.pendingAction;if(validDelivery(event.delivery))g.lastDelivery=event.delivery;this.controls.save();}}else if(event.phase==='running'){t.pendingAction=event.action;if(g?.id===t.grantId){g.pendingAction=event.action;this.controls.save();}}
    if(event.willCapture){try{this.controls.screens.reserve();}catch{void this.stop(t.thread,t.id,'screen cap reached');}}
    if(event.capture){try{this.controls.screens.audit({machine:t.machine,decision:'captured',grantId:t.screenId,approvalId:t.approvalId,...event.capture});t.onCapture?.({machine:t.machine,capturedAt:event.capture.capturedAt});}catch{void this.stop(t.thread,t.id,'screen cap reached');}}
    this.controls.audit(g,{action:event.action,expected_app:event.app,textLength:event.textLength},event.phase||'progress',t.approvalId);
    void t.ui?.update({steps:t.steps,max:t.plan.max_steps,action:event.action,app:event.app,result:event.phase,capture:Boolean(event.capture)});
  }
  async stop(thread,id,reason='owner Stop'){
    const t=this.live.get(thread);if(!t||t.id!==id||t.closed)return;t.closed=true;t.reason=reason;
    await this.controls.off(thread,reason,true,t.grantId);
  }
  async finishFor(thread,reason='finished'){
    const t=this.live.get(thread);if(!t)return;this.live.delete(thread);t.reason ||= reason;t.closed=true;
    await this.controls.hub.request(t.machine,'input_task_finish',{grantId:t.grantId,taskId:t.id}).catch(()=>{});
    await t.ui?.finish(this.summary(t));
  }
  context({thread,scheduled=false,tainted=()=>false,taintTask=()=>null,markBrowser=()=>{},approve=async()=>false,startProgress,notify=async()=>{},onCapture=()=>{},screen,attachmentRequested=false,publish}){
    const manager=this,controls=this.controls,generation=controls.active(thread)?.id,receipts=new Map();let task=null,stopped=false,published=false;
    const gate=machine=>{
      if(task&&!task.ready)throw new Error('Control task Stop UI not ready; wait for propose_task to finish');
      if(stopped||task?.closed)throw new Error('Control task stopped. Ask Ozzy; a new plan is required.');
      if(scheduled||tainted()&&!(task?.browser&&taintTask()===task.id))throw new Error('Control tasks are forbidden in scheduled or tainted sessions.');
      const g=controls.grant(thread),s=controls.screens.grant(thread),n=controls.hub.list().find(n=>canonical(n.machine)===canonical(machine));
      if(g.id!==generation||g.mode!=='task'||s.id!==g.screenId||canonical(machine)!==g.machine||!n?.online||!n.capabilities?.includes('input'))throw new Error('Control task grant, screen or machine changed');return g;
    };
    const preparationFailure=async(stage,error)=>{
      stopped=true;
      const message=`Task preparation failed at ${stage}: ${error.message}. No plan approved; no input sent. The current grant stays in its original mode. Ask Ozzy; do not switch modes or reissue a grant.`;
      if(!error.notified){error.notified=true;await Promise.resolve(notify(message)).catch(()=>{});}
      error.message=message;return error;
    };
    const authorize=async(raw,{signal}={})=>{
      const g=gate(raw.machine);
      if(raw.action==='list_apps')return;
      if(raw.action==='propose_task'){
        if(task)throw new Error('Control task already planned; finish and ask for a new owner instruction');
        let plan,prepared;
        try{plan=normalizePlan(raw);}catch(error){throw await preparationFailure('plan validation',error);}
        if(receipts.has(JSON.stringify(plan)))return;
        try{prepared=await controls.hub.request(g.machine,'input_task_prepare',{grantId:g.id,...plan});}catch(error){throw await preparationFailure('installed-app resolution/fingerprint',error);}
        const approvalId=randomUUID();
        const description=[`Goal: ${plan.goal}`,`Apps: ${prepared.apps.map(app=>`${app.name} (${app.id})`).join(', ')}`,...(prepared.browser?['⚠️ page content could steer bIT — including this browser taints the thread']:[]),...plan.free_text_apps.map(id=>`⚠️ FREE TEXT IN ${id}: arbitrary text may be typed (never terminals)`),`Exact typed texts:\n${plan.texts.map((text,i)=>`${i+1}. ${JSON.stringify(text)}`).join('\n')||'(none)'}`,`Actions: ${plan.allowed_actions.join(', ')}`,`Additional keys: ${plan.key_combos.join(', ')||'none'}`,`Limits: ${plan.max_steps} steps · ${plan.max_minutes} minutes (within existing grant). Terminals, sending, dangerous keys and sensitive/dialog screens require step mode.`].join('\n');
        if(!await approve({tool:'propose_task',action:'Task plan',description,input:{machine:g.machine,...plan,browser:prepared.browser},approvalId,signal}))throw new Error('Control task plan denied; no actions ran');
        gate(raw.machine);if(signal?.aborted)throw new Error('Control task approval cancelled');receipts.set(JSON.stringify(plan),{prepared,approvalId});return;
      }
      if(!task)throw new Error('Control task scope absent: call propose_task and wait for the owner button first');
      if(raw.action==='finish_task')return;
      // Node preflight and dispatch enforce scope; there is never a step card in task mode.
      try{await controls.hub.request(g.machine,'input_task_check',{grantId:g.id,taskId:task.id,...raw});}
      catch(error){stopped=true;await manager.finishFor(thread,'scope refused');if(error.evaluation&&!error.notified){error.notified=true;await notify(error.message);}throw error;}
    };
    const propose=async raw=>{
      try{
        const g=gate(raw.machine),plan=normalizePlan(raw);if(!receipts.has(JSON.stringify(plan)))await authorize({...raw,action:'propose_task'});
        const {prepared,approvalId}=receipts.get(JSON.stringify(plan));receipts.delete(JSON.stringify(plan));
        if(typeof startProgress!=='function')throw new Error('Control task Stop UI unavailable');
        const id=randomUUID(),started=await controls.hub.request(g.machine,'input_task_start',{grantId:g.id,proposalId:prepared.proposalId,approvalId,taskId:id,captureBudget:controls.screens.cap-controls.screens.status().captures});
        task={id,approvalId,grantId:g.id,thread,machine:g.machine,screenId:g.screenId,plan,steps:0,baseCount:g.count,actions:[],browser:prepared.browser,onCapture,expiresAt:started.expiresAt};manager.live.set(thread,task);
        if(task.browser)await markBrowser(id);
        task.ui=await startProgress({id,goal:plan.goal,machine:g.machine,expiresAt:task.expiresAt},()=>manager.stop(thread,id));task.ready=true;
        if(task.closed)throw new Error('Control task stopped before it began');
        return {content:[{type:'text',text:`Task approved: ${id}. Scope is enforced on the node. ${plan.max_steps} steps until ${task.expiresAt}. Use raise_app for allowed installed apps; no per-step cards inside this scope. Stop on ambiguity or escalation.`}]};
      }catch(error){stopped=true;await manager.finishFor(thread,'plan failed');return {isError:true,content:[{type:'text',text:error.message}]};}
    };
    const execute=async raw=>{
      try{
        const g=gate(raw.machine);await authorize(raw);
        if(raw.action==='list_apps'){
          try{return {content:[{type:'text',text:JSON.stringify(await controls.hub.request(g.machine,'input_list_apps',{grantId:g.id}))}]};}
          catch(error){throw await preparationFailure('installed-app listing',error);}
        }
        if(raw.action==='finish_task'){stopped=true;await manager.finishFor(thread);return {content:[{type:'text',text:'Task finished; held input released. A new approved plan is required for more actions.'}]};}
        const result=await controls.hub.request(g.machine,'input_task_action',{grantId:g.id,taskId:task.id,...raw});
        if(task.closed&&task.reason!=='task step cap reached')throw new Error('Control task stopped; verification image discarded');
        const bytes=validateCapture(result.frame),metadata=await sharp(bytes).metadata();if(metadata.width!==result.frame.scaled.width||metadata.height!==result.frame.scaled.height)throw new Error('Control task image geometry invalid');const focused=result.focus?.focused;
        if(attachmentRequested&&publish&&!published){published=true;await publish({buffer:bytes,mimeType:result.frame.mimeType,metadata:{machine:g.machine,capturedAt:result.frame.capturedAt,original:result.frame.original,scaled:result.frame.scaled}});}
        return {content:[{type:'text',text:JSON.stringify({machine:g.machine,steps:result.steps,focused,overviewActive:result.focus?.overviewActive,actual_app:focused?.focusKind==='shell-search'?'gnome-shell-search':focused?.app?.toLowerCase()??'unknown',instruction:'Verify this actual focus and visible result. If ambiguous or unexpected, stop and ask; do not improvise.'})},{type:'image',data:bytes.toString('base64'),mimeType:result.frame.mimeType}]};
      }catch(error){stopped=true;await manager.finishFor(thread,'refused or failed');if(!error.notified){error.notified=true;await Promise.resolve(notify(`${error.message}${validDelivery(error.delivery)?' '+deliveryText(error.delivery):''}. Task stopped; ask Ozzy.`)).catch(()=>{});}return {isError:true,content:[{type:'text',text:`${error.message}${validDelivery(error.delivery)?' '+deliveryText(error.delivery):''}. Task stopped; ask Ozzy. A new approved plan or /control on mode:step is required.`}]};}
    };
    return {taskMode:true,gate,authorize,propose,execute,active:()=>Boolean(task&&!task.closed),finish:async()=>{stopped=true;await manager.finishFor(thread);},end:async reason=>{stopped=true;await manager.stop(thread,task?.id,reason);}};
  }
}
