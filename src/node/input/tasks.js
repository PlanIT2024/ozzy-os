import { randomUUID } from 'node:crypto';
import { validateAction, mapPoint } from './actions.js';
import { normalizePlan, validateApps, assertScope, appKind } from './taskPolicy.js';
import { focusedAppMatches } from './focus.js';
const EXECUTE=Symbol('approved task execution'),RAISE=Symbol('fixed raise macro');
export class NodeTasks {
  constructor(input){this.input=input;this.prepared=new Map();this.active=null;this.busy=false;}
  session(grantId){const s=this.input.session;if(!s||s.grantId!==grantId||s.state.mode!=='task'||this.input.now()>=Date.parse(s.expiresAt))throw new Error('Control task grant unavailable');return s;}
  check(taskId){const t=this.active;this.session(t?.grantId);if(!t||t.id!==taskId||this.input.now()>=t.expiresAt)throw new Error('Control task scope expired, stopped or absent');return t;}
  async prepare({grantId,...raw}){
    this.session(grantId);const plan=normalizePlan(raw),apps=[];
    for(const id of plan.allowed_apps)apps.push(await this.input.backend.resolveApp(id));validateApps(plan,apps);
    this.session(grantId);const proposalId=randomUUID();this.prepared.clear();this.prepared.set(proposalId,{grantId,plan,apps});
    return {proposalId,plan,apps,browser:apps.some(app=>appKind(app).browser)};
  }
  async start({grantId,proposalId,taskId,approvalId,captureBudget}){
    const s=this.session(grantId),p=this.prepared.get(proposalId);this.prepared.delete(proposalId);
    if(!p||p.grantId!==grantId||![taskId,approvalId].every(id=>typeof id==='string'&&/^[a-zA-Z0-9-]{1,80}$/.test(id))||!Number.isInteger(captureBudget)||captureBudget<1||captureBudget>1000)throw new Error('Control task approved proposal unavailable');
    for(const app of p.apps)if(JSON.stringify(await this.input.backend.resolveApp(app.id))!==JSON.stringify(app))throw new Error('Control task desktop app changed since approval');
    this.session(grantId);await this.end('replaced');this.active={...p,id:taskId,approvalId,steps:0,captureBudget,expiresAt:Math.min(Date.parse(s.expiresAt),this.input.now()+p.plan.max_minutes*60000)};
    this.timer=setTimeout(()=>{void this.input.stop('task expired',true);},this.active.expiresAt-this.input.now());this.timer.unref?.();
    this.input.log(`input task approved ${JSON.stringify({taskId,approvalId,apps:p.apps.map(app=>app.id),maxSteps:p.plan.max_steps,expiresAt:new Date(this.active.expiresAt).toISOString()})}`);
    return {taskId,expiresAt:new Date(this.active.expiresAt).toISOString()};
  }
  before(raw,action,observed){
    if(this.input.session?.state.mode!=='task')return;
    const t=this.check(raw.taskId);
    if(raw[EXECUTE]!==t)throw new Error('Control task scope refused: step path cannot bypass a task');
    if(t.steps>=t.plan.max_steps||this.input.session.state.count>=this.input.session.maxActions||t.captureBudget<1)throw new Error('Control task cap reached');
    assertScope(t,action,observed,{raising:raw[RAISE]===t,raiseApp:t.raiseApp});
    t.steps++;t.captureBudget--;
    this.input.emit('task_progress',{taskId:t.id,grantId:t.grantId,action:action.action,app:action.expected_app||action.app,steps:t.steps,textLength:action.action==='type'?[...action.text].length:undefined,phase:'running',willCapture:true});
  }
  flags(raw){return this.input.session?.state.mode==='task'?{task_mode:true,raise_step:raw[RAISE]===this.active,task_step:`${raw[RAISE]===this.active?'raise_app/':''}${raw.action} #${this.active?.steps}`}:{};}
  async wait(t){while(this.input.now()-(this.input.state.lastActionAt??-Infinity)<1000){this.check(t.id);await new Promise(resolve=>setTimeout(resolve,25));}this.check(t.id);}
  async capture(t,action,result){
    this.check(t.id);const frame=await this.input.screen.capture();this.check(t.id);this.input.observe(frame);
    const metadata={capturedAt:frame.capturedAt,original:{width:frame.original.width,height:frame.original.height},scaled:{width:frame.scaled.width,height:frame.scaled.height}};
    this.input.emit('task_progress',{taskId:t.id,grantId:t.grantId,action,app:result?.focus?.focused?.app??'unknown',steps:t.steps,phase:'verified',delivery:result?.delivery,capture:metadata});
    return {frame,focus:result?.focus,steps:t.steps,taskId:t.id};
  }
  async step(t,raw,{raising=false}={}){
    this.check(t.id);await this.wait(t);
    const action=validateAction(raw,{screenshot:false});
    let expectedFocus,approvedApp;
    if(action.action==='launch_app')approvedApp=t.apps.find(app=>app.id===action.app);
    else expectedFocus=(await this.input.inspect({grantId:t.grantId,...action})).focused;
    const result=await this.input.act({grantId:t.grantId,taskId:t.id,...action,expectedFocus,approvedApp,[EXECUTE]:t,...(raising?{[RAISE]:t}:{})});
    try{return await this.capture(t,action.action,result);}catch(error){if(result.delivery)error.delivery=result.delivery;throw error;}
  }
  async inspect(raw){
    try{
    const t=this.check(raw.taskId);if(raw.grantId!==t.grantId)throw new Error('Control task grant mismatch');
    if(raw.action==='raise_app'){if(!t.plan.allowed_actions.includes('raise_app')||!t.apps.some(app=>app.id===raw.app))throw new Error('Control task scope refused: raise target outside plan');return {allowed:true};}
    const action=validateAction(raw);
    let observed;
    if(action.action!=='screenshot')observed=await this.input.backend.inspect(action.coordinate?mapPoint(action.coordinate,this.input.frame):undefined);
    assertScope(t,action,observed);return {allowed:true};
    }catch(error){if(error.evaluation)this.input.log(`input escalation ${JSON.stringify(error.evaluation)}`);throw error;}
  }
  async action(raw){
    const t=this.check(raw.taskId);if(raw.grantId!==t.grantId)throw new Error('Control task grant mismatch');
    if(this.busy)throw new Error('Control task step already running');this.busy=true;
    try{
      await this.inspect(raw);
      let result;
      if(raw.action==='raise_app'){
        if(!t.plan.allowed_actions.includes('raise_app'))throw new Error('Control task scope refused: raise_app not allowed');
        const app=t.apps.find(app=>app.id===raw.app);if(!app)throw new Error('Control task scope refused: raise target not allowed');t.raiseApp=app;
        const initial=(await this.input.backend.inspect()).focused;this.input.log(`input raise starting ${JSON.stringify({taskId:t.id,target:app.id,focusedApp:initial?.app,windowId:initial?.windowId})}`);
        result=await this.step(t,{action:'launch_app',app:app.id},{raising:true});
        if(!focusedAppMatches(result.focus?.focused,app)){
          const focus=(await this.input.backend.inspect()).focused;if(!focus)throw new Error('Control task raise refused: actual starting focus unknown');
          result=await this.step(t,{action:'key',keys:'super',expected_app:focus.app.toLowerCase()},{raising:true});
          result=await this.step(t,{action:'focus_search',expected_app:'gnome-shell'},{raising:true});
          result=await this.step(t,{action:'type',text:app.name,expected_app:'gnome-shell-search'},{raising:true});
          result=await this.step(t,{action:'key',keys:'enter',expected_app:'gnome-shell-search'},{raising:true});
          if(!focusedAppMatches(result.focus?.focused,app))throw new Error('Control task raise failed: target is not focused; ask Ozzy to bring it forward');
        }
        delete t.raiseApp;
      }else if(raw.action==='screenshot'){
        assertScope(t,{action:'screenshot'});this.before({taskId:t.id,[EXECUTE]:t},{action:'screenshot'});this.input.session.state.count++;this.input.save();
        result=await this.capture(t,'screenshot',{focus:await this.input.backend.inspect()});
      }else {result=await this.step(t,raw);if(raw.action==='launch_app'&&!focusedAppMatches(result.focus?.focused,t.apps.find(app=>app.id===raw.app)))throw new Error('Control task launch completed but target is not focused; ask Ozzy');}
      if(t.steps>=t.plan.max_steps)await this.end('task step cap reached');
      return result;
    }catch(error){if(error.evaluation)this.input.log(`input escalation ${JSON.stringify(error.evaluation)}`);await this.end('task refused or failed');throw error;}
    finally{this.busy=false;}
  }
  async end(reason='finished'){
    const t=this.active;this.active=null;clearTimeout(this.timer);
    if(t){this.input.emit('task_ended',{taskId:t.id,grantId:t.grantId,steps:t.steps,reason});await this.input.backend.releaseAll().catch(()=>{});}
  }
}
