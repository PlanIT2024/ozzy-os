import { NodeTasks } from './tasks.js';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { ROOT, readJSON, saveJSON } from '../../shared.js';
import { validateAction, mapPoint, actionLog, ACTIONS } from './actions.js';
import { deliveryPlan, deliveryText, validDelivery } from './delivery.js';
import { assertSafeFocus, shellSuper, focusRefusal } from './focus.js';
import { LinuxInput } from './linux.js';
export class UnsupportedInput extends EventEmitter {
  async available() { return false; }
  async start() { throw new Error('Input control not supported yet on this platform'); }
  async stop() {}
  async releaseAll() {}
}
export class InputControl extends EventEmitter {
  constructor({ platform = process.platform, enabled = process.env.CONTROL_ENABLED === 'true', screen, backend = platform === 'linux' ? new LinuxInput() : new UnsupportedInput(), now = () => Date.now(), cap = Number(process.env.BIT_CONTROL_MAX_ACTIONS ?? 40), root = ROOT, log = console.log, logText = process.env.CONTROL_LOG_TEXT === 'true' } = {}) {
    super(); if (!Number.isInteger(cap) || cap < 1 || cap > 1000) throw new Error('Invalid control action cap');
    Object.assign(this, { enabled, screen, backend, now, cap, root, log, logText });
    this.file = path.join(root, 'data/node-control.json'); this.state = readJSON(this.file, { grants: {} });this.tasks=new NodeTasks(this);
    backend.on('closed', details => { void this.stop(details?.reason || 'GNOME Stop', true); });
  }
  save() { try { saveJSON(this.file,this.state); } catch { this.faulted=true; throw new Error('Control state persistence failed'); } }
  async available() { return !this.faulted && this.enabled && await this.screen.available() && await this.backend.available(); }
  observe(frame) { this.frame = { original: frame.original, scaled: frame.scaled, monitors: frame.monitors, capturedAt: frame.capturedAt }; }
  async start({ grantId, expiresAt, maxActions, mode='step' }) {
    if (this.enabled && this.backend instanceof UnsupportedInput) return this.backend.start();
    if (!this.enabled || !await this.available()) throw new Error('Input capability unavailable');
    if (typeof grantId !== 'string' || !/^[a-zA-Z0-9-]{1,80}$/.test(grantId) || !Number.isFinite(Date.parse(expiresAt)) || Date.parse(expiresAt) <= this.now() || Date.parse(expiresAt) > this.now()+600000 || !Number.isInteger(maxActions) || maxActions < 1) throw new Error('Invalid control grant');
    if(!['step','task'].includes(mode)||this.state.grants[grantId]?.mode&&this.state.grants[grantId].mode!==mode)throw new Error('Control mode cannot change inside a grant');
    if (this.state.grants[grantId]?.revoked) throw new Error('Node control session was revoked');
    if (this.session?.grantId === grantId) return { started: true, grantId, newSession: false };
    await this.stop('replaced');
    const state = Object.hasOwn(this.state.grants,grantId) ? this.state.grants[grantId] : (this.state.grants[grantId] = { count: 0, last: 0 });
    state.mode ||= mode;
    state.expiresAt ||= expiresAt;
    state.maxActions = Math.min(state.maxActions ?? this.cap, this.cap, maxActions);
    expiresAt = new Date(Math.min(Date.parse(state.expiresAt), Date.parse(expiresAt))).toISOString();
    state.expiresAt = expiresAt;
    if (Date.parse(expiresAt) <= this.now() || state.count >= state.maxActions) throw new Error('Control grant expired or capped at node');
    this.save();
    this.session = { grantId, expiresAt, maxActions: state.maxActions, state };
    this.log(`input start ${JSON.stringify({grantId,expiresAt,maxActions:this.session.maxActions})}`);
    this.timer = setTimeout(() => { void this.stop('expired', true); }, Date.parse(expiresAt)-this.now()); this.timer.unref?.();
    try { await this.backend.start(); }
    catch { await this.stop('portal start failed', true); throw new Error('RemoteDesktop consent failed; see node portal diagnostics'); }
    if (!this.session || this.now() >= Date.parse(expiresAt) || !await this.available()) { await this.stop('expired or locked during consent', true); throw new Error('Control grant expired or session became unavailable during consent'); }
    return { started: true, grantId, newSession: true };
  }
  async inspect(raw = {}) {
    if (!this.session || raw.grantId !== this.session.grantId || this.now() >= Date.parse(this.session.expiresAt) || !await this.available()) throw new Error('Control focus unavailable');
    const action = validateAction(raw);
    if(shellSuper(action)&&this.session.state.lastInput==='super')throw new Error('Control refused a consecutive Super press before approval; use launch_app instead');
    const point = action.coordinate ? mapPoint(action.coordinate,this.frame) : undefined;
    const result = await this.backend.inspect(point,{searchFocus:action.action==='focus_search'}).catch(error=>{if(shellSuper(action))return{focused:null,focusReason:'missing-accessibility'};throw new Error(focusRefusal('missing-accessibility','focus'));});
    if (action.end) result.destination = await this.backend.inspect(mapPoint(action.end,this.frame)).catch(()=>{throw new Error(focusRefusal('missing-accessibility'));});
    if(action.action!=='screenshot'){assertSafeFocus(result,action,result.focused);if(result.destination)assertSafeFocus(result.destination,action,result.focused);}
    return result;
  }
  async resolveApp(raw){
    if(!this.session||raw.grantId!==this.session.grantId||this.now()>=Date.parse(this.session.expiresAt)||this.session.state.count>=this.session.maxActions||!await this.available())throw new Error('Control unavailable for app launch');
    return this.backend.resolveApp(validateAction({action:'launch_app',app:raw.app}).app);
  }
  async act(raw) {
    this.log(`input attempt ${JSON.stringify({ action: ACTIONS.includes(raw?.action) ? raw.action : 'invalid' })}`);
    const keyboard=['type','key'].includes(raw?.action);
    let delivery=keyboard?deliveryPlan(raw):undefined,dispatched=false;
    try {
      const action = validateAction(raw, { screenshot: false });
      this.log(`input action ${JSON.stringify(actionLog(action,this.logText))}`);
      const s = this.session;
      if (!this.enabled || !s || raw.grantId !== s.grantId || this.busy || this.now() >= Date.parse(s.expiresAt) || s.state.count >= s.maxActions || !await this.available()) throw new Error('Control unavailable, expired, busy, locked or capped');
      if (this.session !== s) throw new Error('Control session changed');
      const lastAction = this.state.lastActionAt ?? (s.state.count > 0 ? s.state.last : -Infinity);
      if (this.now()-lastAction < 1000) throw new Error('Input rate limit: one action per second');
      if(action.action==='key'&&action.keys==='super'&&s.state.lastInput==='super')throw new Error('Control refused a consecutive Super press; use launch_app instead');
      if (action.action!=='launch_app' && (!this.frame || this.now()-Date.parse(this.frame.capturedAt) > 120000)) throw new Error('Take a recent screenshot before input');
      const mapped = { ...action, ...(action.coordinate ? { point: mapPoint(action.coordinate,this.frame) } : {}), ...(action.end ? { destination: mapPoint(action.end,this.frame) } : {}) };
      let observed;
      if(action.action!=='launch_app'){
      observed = await this.backend.inspect(mapped.point,{searchFocus:action.action==='focus_search'}).catch(error=>{if(shellSuper(action))return{focused:null,focusReason:'missing-accessibility'};throw new Error(focusRefusal('missing-accessibility','focus'));});
      assertSafeFocus(observed,action,raw.expectedFocus);
      if (mapped.destination) assertSafeFocus(await this.backend.inspect(mapped.destination).catch(()=>{throw new Error(focusRefusal('missing-accessibility'));}),action,raw.expectedFocus);
      }else{if(s.state.mode==='task')observed=await this.backend.inspect();const app=await this.backend.resolveApp(action.app);if(JSON.stringify(app)!==JSON.stringify(raw.approvedApp))throw new Error('Control installed app changed since approval');}
      if(this.session!==s || this.busy || this.now()>=Date.parse(s.expiresAt) || s.state.count>=s.maxActions) throw new Error('Control session changed during focus check');
      if(this.now()-(this.state.lastActionAt??-Infinity)<1000) throw new Error('Input rate limit: one action per second');
      this.tasks.before(raw,action,observed);
      Object.assign(mapped,this.tasks.flags(raw));
      mapped.expectedFocus = raw.expectedFocus;
      this.busy = true; s.state.last = this.now(); this.state.lastActionAt = this.now(); s.state.count++; this.save();
      dispatched=true;const receipt=action.action==='launch_app'?await this.backend.launchApp(raw.approvedApp):await this.backend.act(mapped);
      delivery=keyboard&&validDelivery(receipt?.delivery)?receipt.delivery:delivery;
      if(['type','key'].includes(action.action))s.state.lastDelivery=delivery;
      s.state.lastInput=action.action==='key'&&action.keys==='super'?'super':action.action;this.save();
      if (this.session !== s) throw new Error('Control session ended during action');
      if (s.state.count >= s.maxActions) await this.stop('action cap',true);
      return { delivery, action: action.action, count: s.state.count, focus: await this.backend.inspect().catch(()=>({focused:null,focusReason:'missing-accessibility'})) };
    } catch (error) {
      delivery=keyboard?(validDelivery(error.delivery)?error.delivery:dispatched&&delivery?.state==='none'?{...delivery,state:'uncertain'}:delivery):undefined;
      // Fixed/validated error messages only; never propagate helper input/stdout.
      if(Object.hasOwn(this.state.grants,raw?.grantId)){if(keyboard)this.state.grants[raw.grantId].lastDelivery=delivery;else delete this.state.grants[raw.grantId].lastDelivery;try{this.save();}catch{}}
      this.log(`input failure ${JSON.stringify({ stage:'action', delivery, reason: /^(?:Blocked|Unsupported|Invalid|Typed|Coordinates|Screenshot|Take|Input rate|Control)/.test(error.message) ? error.message : 'portal action failed' })}`);
      await this.backend.releaseAll().catch(()=>{});
      const keepGrant=raw?.action==='launch_app'&&error.launchFailure===true&&this.session&&this.now()<Date.parse(this.session.expiresAt)&&this.session.state.count<this.session.maxActions&&!this.faulted;
      if(this.session?.state.mode==='task')await this.tasks.end('task refused or failed');
      else if(!keepGrant)await this.stop('action failure',true);
      throw Object.assign(new Error((/^(Control|Blocked application)/.test(error.message)?error.message:'Input action refused or failed; control ended. See node diagnostics.')+(['type','key'].includes(raw?.action)?' '+deliveryText(delivery):'')),{delivery,launchFailure:keepGrant});
    } finally { this.busy = false; await this.backend.releaseAll().catch(()=>{}); }
  }
  async stop(reason = 'owner off', revoke = false) {
    const s = this.session; this.session = null;if(s?.state.mode==='task')this.backend.cancel?.();await this.tasks.end(reason); clearTimeout(this.timer); this.frame = null;
    if (s && revoke) { s.state.revoked = true; try { this.save(); } catch { this.log('input failure stage=persist_revocation; capability disabled'); } }
    if (s) { this.log(`input ended ${JSON.stringify({grantId:s.grantId,reason,count:s.state.count})}`); this.emit('closed',{grantId:s.grantId,reason,count:s.state.count,delivery:['action failure','action cap'].includes(reason)&&validDelivery(s.state.lastDelivery)?s.state.lastDelivery:undefined}); }
    await this.backend.releaseAll().catch(()=>{}); await this.backend.stop().catch(()=>{});
  }
  async close() { await this.stop('disconnect'); }
}
export function createInput(options) { return new InputControl(options); }
