import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { ROOT, readJSON, saveJSON } from '../shared.js';
import { canonical } from '../../relay/wire.js';
import { validateAction, actionLog, mapPoint } from '../node/input/actions.js';
import { validateCapture } from '../node/screen/image.js';
import { assertSafeFocus, terminalFocus } from '../node/input/focus.js';
import sharp from '../node/screen/sharp.js';
export class ControlGrants {
  constructor({root=ROOT,hub,screens,now=()=>Date.now(),cap=Number(process.env.BIT_CONTROL_MAX_ACTIONS??40)}={}){
    if(!Number.isInteger(cap)||cap<1||cap>1000)throw new Error('Invalid control cap');
    Object.assign(this,{root,hub,screens,now,cap});this.file=path.join(root,'data/controls.json');this.state=readJSON(this.file,{grants:{},previews:{}});this.listeners=new Map();this.timers=new Map();this.warningTimers=new Map();
    hub?.on?.('control_closed',({machine,grantId,reason})=>{
      for(const [thread,g]of Object.entries(this.state.grants))if(!g.revokedAt&&canonical(machine)===g.machine&&(!grantId||grantId===g.id)){
        if(['runtime suspended','disconnect'].includes(reason)){g.runtimeClosedAt=new Date(this.now()).toISOString();try{this.save();this.audit(g,null,'suspended');}catch{console.warn('Control suspension persistence unavailable');}}
        else void this.off(thread,reason||'GNOME Stop',false,g.id);
      }
    });
    for(const [thread,g]of Object.entries(this.state.grants))if(!g.revokedAt)this.arm(thread,g);
  }
  save(){saveJSON(this.file,this.state);}
  audit(grant,action,decision,approvalId){fs.mkdirSync(path.join(this.root,'data'),{recursive:true,mode:0o700});fs.appendFileSync(path.join(this.root,'data/audit.log'),JSON.stringify({event:'control',time:new Date(this.now()).toISOString(),machine:grant?.machine,grantId:grant?.id,approvalId,decision,...(action?actionLog(action):{})})+'\n',{mode:0o600});}
  async warn(thread,g){
    if(g.revokedAt||this.state.grants[thread]?.id!==g.id||g.warnedAt||this.now()>=Date.parse(g.expiresAt))return;
    g.warnedAt=new Date(this.now()).toISOString();this.save();
    const notify=this.listeners.get(thread)||(this.notifyThread?text=>this.notifyThread(thread,text):null);
    if(!notify){delete g.warnedAt;this.save();return;}
    await notify(`⚠️ Control on ${g.machine} expires in 2 minutes. Finish safely or hand back to Ozzy.`);
  }
  arm(thread,g){clearTimeout(this.warningTimers.get(thread));if(!g.warnedAt&&this.now()<Date.parse(g.expiresAt)){const warning=setTimeout(()=>{void this.warn(thread,g).catch(()=>console.warn('Control expiry warning unavailable'));},Math.max(0,Date.parse(g.expiresAt)-this.now()-120000));warning.unref?.();this.warningTimers.set(thread,warning);}clearTimeout(this.timers.get(thread));const timer=setTimeout(()=>{void this.off(thread,'expired');},Math.max(0,Date.parse(g.expiresAt)-this.now()));timer.unref?.();this.timers.set(thread,timer);}
  subscribe(thread,notify){this.listeners.set(thread,notify);const g=this.active(thread);if(g&&!g.warnedAt)this.arm(thread,g);}
  isTainted(thread,web,sessionKey){return Boolean(web.session(sessionKey||thread).tainted);}
  grant(thread){const g=this.state.grants[thread];if(!g||g.revokedAt)throw new Error('No active control grant here, Ozzy. Use /control on in this thread.');if(this.now()>=Date.parse(g.expiresAt)||!Number.isFinite(Date.parse(g.expiresAt)))throw new Error('Control grant expired, Ozzy.');if(g.count>=g.maxActions)throw new Error('Control action cap reached, Ozzy.');return g;}
  active(thread){try{return this.grant(thread);}catch{return null;}}
  describe(thread){try{const g=this.grant(thread);return `Control: ${g.machine} until ${g.expiresAt} · ${g.count}/${g.maxActions} steps · input steps need ✅; screenshots automatic · preview ${this.state.previews[thread]?'on':'off'}.`;}catch(error){return error.message;}}
  preview(thread,value){this.state.previews[thread]=Boolean(value);this.save();}
  async on(thread,machine,{withScreen=false,tainted=false}={}){
    if(tainted)throw new Error('Web-tainted threads cannot control a computer, Ozzy. Start a fresh thread.');
    machine=canonical(machine);const n=this.hub.list().find(n=>canonical(n.machine)===machine&&n.online&&n.capabilities?.includes('input')&&n.capabilities?.includes('screen'));
    if(!n)throw new Error('That machine has no input capability, Ozzy.');
    let screen=this.screens.active(thread);
    if(!screen||screen.machine!==machine){if(!withScreen)throw new Error('Use /screen on for this machine first, or /control on with-screen:true.');this.screens.on(thread,machine);screen=this.screens.grant(thread);}
    for(const [other,g]of Object.entries(this.state.grants))if(!g.revokedAt&&(g.machine===machine||other===thread))await this.off(other,'replaced');
    const g={id:randomUUID(),machine,issuedAt:new Date(this.now()).toISOString(),expiresAt:new Date(Math.min(this.now()+600000,Date.parse(screen.expiresAt))).toISOString(),count:0,maxActions:this.cap,actions:[],screenId:screen.id};
    this.state.grants[thread]=g;this.save();this.arm(thread,g);this.audit(g,null,'on');
    try{await this.hub.request(machine,'input_start',{grantId:g.id,expiresAt:g.expiresAt,maxActions:g.maxActions});if(this.grant(thread).id!==g.id)throw new Error('Control grant changed during consent');}
    catch{await this.off(thread,'portal consent failed');throw new Error('Control consent failed or session ended, Ozzy. Check the machine’s GNOME dialog and node logs.');}
    return g;
  }
  async off(thread,reason='owner off',send=true,expectedId){
    const g=this.state.grants[thread];if(!g||g.revokedAt||(expectedId&&g.id!==expectedId))return;
    g.revokedAt=new Date(this.now()).toISOString();g.reason=reason;clearTimeout(this.timers.get(thread));clearTimeout(this.warningTimers.get(thread));try{this.save();this.audit(g,null,'off');}catch{console.warn('Control revocation persistence failed; stopping node anyway');}
    if(send)await this.hub.request(g.machine,'input_stop',{grantId:g.id}).catch(()=>{});
    const notify=this.listeners.get(thread)|| (this.notifyThread ? text=>this.notifyThread(thread,text) : ()=>{});
    await Promise.resolve(notify(`🖱️ control ended on ${g.machine}: ${g.count} steps (completed: ${g.actions.join(', ')||'none'}${g.pendingAction ? '; unverified: '+g.pendingAction : ''}). ${reason}.`)).catch(()=>console.warn('Control end notification unavailable'));
  }
  async close(){
    for(const g of Object.values(this.state.grants))if(!g.revokedAt){await this.hub.request(g.machine,'input_stop',{grantId:g.id,revoke:false}).catch(()=>{});try{this.audit(g,null,'suspended');}catch{console.warn('Control suspension audit unavailable');}}
    for(const timer of [...this.timers.values(),...this.warningTimers.values()])clearTimeout(timer);
  }
  context({thread,scheduled=false,tainted=()=>false,approve=async()=>false,notify=async()=>{},screen}){
    let stopped=false,frame=null,reservation=null;const generation=this.active(thread)?.id;const receipts=new Map();
    const gate=machine=>{
      if(stopped)throw new Error('This control task ended. Ask Ozzy what to do instead.');
      if(scheduled)throw new Error('Scheduled jobs cannot control computers.');
      if(tainted()){void this.off(thread,'thread tainted',true,generation);throw new Error('Tainted threads cannot control computers. Start a fresh thread.');}
      const g=this.grant(thread),s=this.screens.grant(thread),n=this.hub.list().find(n=>canonical(n.machine)===canonical(machine));
      if(g.id!==generation)throw new Error('Control grant changed; start a new conversation turn.');
      if(canonical(machine)!==g.machine||s.machine!==g.machine||s.id!==g.screenId||!n?.online||!n.capabilities?.includes('input')||!n.capabilities?.includes('screen'))throw new Error('Control grant, screen grant or input capability unavailable for this machine.');
      return g;
    };
    const receiptKey=raw=>JSON.stringify({machine:canonical(raw.machine),target:raw.target,...validateAction(raw)});
    const authorize=async(raw,{signal}={})=>{
      let g,action,approvalId,ticket;
      try{
        g=gate(raw.machine);action=validateAction(raw);
        if(typeof raw.target!=='string'||!raw.target.trim()||raw.target.length>240)throw new Error('Describe the action target in words before requesting approval.');
        if(action.action!=='screenshot'&&!frame)throw new Error('Use computer screenshot to inspect the screen before input.');
        if(action.coordinate)mapPoint(action.coordinate,frame);
        if(action.end)mapPoint(action.end,frame);
        this.screens.checkCap();
        if(reservation)throw new Error('Wait for the current control step to finish before proposing another.');
        ticket=reservation={key:receiptKey(raw)};
        const observedFrame=frame;
        let focus;
        if(action.action!=='screenshot'){
          focus=await this.hub.request(g.machine,'input_focus',{grantId:g.id,...action});
          assertSafeFocus(focus,action,['key','type'].includes(action.action)?focus.focused:undefined);
          if(action.end)assertSafeFocus(focus.destination,action);
        }
        approvalId=action.action==='screenshot'?undefined:randomUUID();
        const details=[...(terminalFocus(focus?.focused)?['⚠️ Typing into a terminal runs commands.']:[]),`Focused: ${focus?.focused?.app ?? 'unknown'} — ${focus?.focused?.window ?? 'unknown'}`,...(action.coordinate?[`At target: ${focus?.target?.app ?? 'unknown'} — ${focus?.target?.window ?? 'unknown'}`]:[]),`${action.action} on ${g.machine}`,`Target: ${raw.target}`,...(action.coordinate?[`Coordinates: ${action.coordinate.join(', ')}${action.end?' → '+action.end.join(', '):''}`]:[]),...(action.keys?[`Keys: ${action.keys}`]:[]),...(action.direction?[`Scroll: ${action.direction} ${action.amount}`]:[]),...(action.action==='type'?[`Exact text:\n${action.text}`]:[])].join('\n');
        let preview;
        if(this.state.previews[thread]&&frame&&action.coordinate){const bytes=validateCapture(frame),[x,y]=action.coordinate;const left=Math.max(0,Math.min(frame.scaled.width-1,Math.floor(x)-80)),top=Math.max(0,Math.min(frame.scaled.height-1,Math.floor(y)-60));preview=await sharp(bytes).extract({left,top,width:Math.min(160,frame.scaled.width-left),height:Math.min(120,frame.scaled.height-top)}).png().toBuffer();}
        await notify(`Intent: ${action.action} · ${raw.target}`);
        const allowed=action.action==='screenshot'||await approve({tool:'computer',action:'Computer',description:details,input:{machine:g.machine,target:raw.target,...action,focus},approvalId,signal,preview});
        if(!allowed||signal?.aborted){stopped=true;await this.off(thread,'step denied',true,generation);throw new Error('Step denied; task ended. Ask Ozzy what to do instead.');}
        if(frame!==observedFrame)throw new Error('Screen changed during approval; inspect again.');
        if(gate(raw.machine).id!==g.id)throw new Error('Control grant changed during approval.');
        this.screens.checkCap();this.audit(g,action,action.action==='screenshot'?'allowed':'approved',action.action==='screenshot'?undefined:approvalId);
        const key=receiptKey(raw);receipts.set(key,[...(receipts.get(key)||[]),{g,action,approvalId,frame:observedFrame,ticket,focus}]);
      }catch(error){if(reservation===ticket)reservation=null;this.audit(g,action,'denied',approvalId);throw error;}
    };
    const execute=async raw=>{
      let g,action,receipt;
      try{
        g=gate(raw.machine);receipt=receipts.get(receiptKey(raw))?.shift();
        if(!receipt){await authorize(raw);receipt=receipts.get(receiptKey(raw))?.shift();}
        if(!receipt||receipt.g.id!==gate(raw.machine).id)throw new Error('Missing step approval');
        this.screens.checkCap();
        action=receipt.action;
        if(action.action!=='screenshot'&&receipt.frame!==frame)throw new Error('Screen changed after approval; stop and inspect.');
        let skipped=false;
        if(action.action!=='screenshot'){
          const started=await this.hub.request(g.machine,'input_start',{grantId:g.id,expiresAt:g.expiresAt,maxActions:g.maxActions});
          skipped=started.newSession===true;delete g.runtimeClosedAt;this.save();
          if(!skipped){g.count++;g.pendingAction=action.action;this.save();await this.hub.request(g.machine,'input_action',{grantId:g.id,...action,expectedFocus:receipt.focus?.focused});g.actions.push(action.action);delete g.pendingAction;this.save();}
        }
        if(action.action==='screenshot'){g.count++;this.save();}
        const result=await screen.capture(g.machine);
        if(result.isError)throw new Error('Verification screenshot failed; stop and ask Ozzy.');
        if(action.action==='screenshot'){g.actions.push('screenshot');this.save();}
        const text=result.content.find(block=>block.type==='text'),image=result.content.find(block=>block.type==='image');
        const metadata=JSON.parse(text.text);frame={...metadata,data:image.data,mimeType:image.mimeType,bytes:Buffer.from(image.data,'base64').length};
        if(action.action!=='screenshot'){const actual=await this.hub.request(g.machine,'input_focus',{grantId:g.id,action:'screenshot'}).catch(()=>null);result.content.unshift({type:'text',text:`Reported focused application after action: ${actual?.focused?.app??'unknown'} — ${actual?.focused?.window??'unknown'}. Verify this matches the intended application before proposing type/key. If unexpected, stop and report; do not repair in another app.`});}
        this.audit(g,action,skipped?'restored_without_input':'executed',receipt.approvalId);
        if(skipped)result.content.unshift({type:'text',text:'Control session restored; no input was sent. Inspect this fresh screenshot and request a new step approval.'});
        if(g.count>=g.maxActions){stopped=true;await this.off(thread,'action cap',true,generation);}
        return result;
      }catch(error){if(/^Control focus changed/.test(error.message)){frame=null;delete g.pendingAction;this.save();this.audit(g,action,'focus_changed');return{isError:true,content:[{type:'text',text:error.message+' Take a fresh screenshot and ask for a new approval.'}]};}stopped=true;await this.off(thread,'control step failed',true,generation);this.audit(g,action,'failed');return{isError:true,content:[{type:'text',text:/grant|capability|Tainted|Scheduled|approval|denied|screen|target|Control|control task|focus|Blocked application/.test(error.message)?error.message:'Control ended after a failed step, Ozzy. What should I do instead?'}]};}
      finally{if(receipt?.ticket===reservation)reservation=null;}
    };
    return {authorize,execute,gate,end:async reason=>{stopped=true;await this.off(thread,reason,true,generation);}};
  }
}
