import { keyNames } from './actions.js';
import {checkHazards,escalationError} from './escalation.js';
import { terminalFocus } from './focus.js';
export const TASK_ACTIONS=['screenshot','raise_app','launch_app','mouse_move','left_click','right_click','double_click','drag','scroll','key','type'];
const navigation=new Set(['enter','escape','tab','shift+tab','left','right','up','down','home','end','pageup','pagedown','backspace','ctrl+a','ctrl+c','ctrl+x','ctrl+z','ctrl+y','ctrl+s','ctrl+shift+z','ctrl+left','ctrl+right','ctrl+home','ctrl+end','shift+left','shift+right','shift+up','shift+down','shift+home','shift+end','ctrl+shift+left','ctrl+shift+right']);
export function dangerousKeys(keys){
  keys=keyNames(keys).join('+');
  return ['ctrl+w','ctrl+q','alt+f4','ctrl+enter','ctrl+v','ctrl+shift+v','shift+insert'].includes(keys)||keys.split('+').includes('delete');
}
export function appKind(app){
  const names=[app.name,app.id,...(app.focusNames||[])].join(' ');
  return {terminal:app.terminal===true||terminalFocus({app:names})||/\b(?:bash|zsh|fish|powershell|cmd|sh)\b/i.test(names),browser:app.browser===true||/firefox|chromium|chrome|brave|librewolf|epiphany|vivaldi|opera|msedge|falkon/i.test(names),messaging:app.messaging===true||/discord|slack|telegram|signal|whatsapp|thunderbird|evolution|geary|outlook|teams|element|messenger|zulip|mattermost/i.test(names)};
}
export function normalizePlan(raw){
  if(!raw||typeof raw.goal!=='string'||!raw.goal.trim()||raw.goal.length>800)throw new Error('Control task needs a clear goal (1–800 characters)');
  if(!Array.isArray(raw.allowed_apps)||!raw.allowed_apps.length||raw.allowed_apps.length>12||raw.allowed_apps.some(id=>typeof id!=='string'||!/^[-a-zA-Z0-9_.]+\.desktop$/.test(id)))throw new Error('Control task allowed_apps must be exact desktop IDs');
  if(!Array.isArray(raw.texts)||raw.texts.length>40||raw.texts.some(text=>typeof text!=='string'||!text.length||[...text].length>500||/[\x00-\x08\x0b-\x1f\x7f]/.test(text)))throw new Error('Control task texts must be exact strings, each at most 500 characters');
  if(!Array.isArray(raw.allowed_actions)||!raw.allowed_actions.length||raw.allowed_actions.some(action=>!TASK_ACTIONS.includes(action)))throw new Error('Control task needs explicit supported action types');
  const max_steps=raw.max_steps??25,max_minutes=raw.max_minutes??10,free_text_apps=raw.free_text_apps??[],key_combos=raw.key_combos??[];
  if(!Number.isInteger(max_steps)||max_steps<1||max_steps>40||!Number.isInteger(max_minutes)||max_minutes<1||max_minutes>10)throw new Error('Control task limits: 1–40 steps, 1–10 minutes');
  if(!Array.isArray(free_text_apps)||free_text_apps.some(id=>!raw.allowed_apps.includes(id)))throw new Error('Control task free text apps must be explicitly allowed desktop IDs');
  if(!Array.isArray(key_combos)||key_combos.length>40)throw new Error('Control task key_combos must be a list');
  const keys=key_combos.map(keys=>keyNames(keys).join('+'));
  if(keys.some(keys=>dangerousKeys(keys)||keys.split('+').includes('super')||keys==='shift+enter'))throw new Error('Control task escalation required: dangerous, clipboard or Shell keys need step mode');
  return {goal:raw.goal.trim(),allowed_apps:[...new Set(raw.allowed_apps)],texts:[...raw.texts],allowed_actions:[...new Set(raw.allowed_actions)],max_steps,max_minutes,free_text_apps:[...new Set(free_text_apps)],key_combos:[...new Set(keys)]};
}
export function validateApps(plan,apps){
  if(apps.length!==plan.allowed_apps.length||apps.some((app,i)=>app.id!==plan.allowed_apps[i]))throw new Error('Control task app resolution changed');
  for(const app of apps){if(appKind(app).terminal)throw new Error('Control task escalation required: terminals require /control on mode:step');if(/discord/i.test([app.id,app.name,...(app.focusNames||[])].join(' ')))throw new Error('Blocked application: Discord cannot enter a task scope');}
}
export function scopeApp(scope,expected){
  const matches=scope.apps.filter(app=>app.focusNames?.some(name=>name.toLowerCase()===expected?.toLowerCase())||app.name?.toLowerCase()===expected?.toLowerCase()||app.id.replace(/\.desktop$/,'').toLowerCase()===expected?.toLowerCase());
  if(matches.length!==1)throw new Error('Control task scope refused: expected_app is not a unique allowed installed app');
  return matches[0];
}
export function assertScope(scope,action,observed,{raising=false,raiseApp}={}){
  if(!raising&&!scope.plan.allowed_actions.includes(action.action))throw new Error('Control task scope refused: action type is outside the plan');
  if(action.action==='launch_app'){
    if(!scope.apps.some(app=>app.id===action.app))throw new Error('Control task scope refused: launch target is outside the plan');return;
  }
  if(action.action==='screenshot')return;
  if(raising){
    if(action.action==='key'&&action.keys==='super')return;
    checkHazards(action,observed,scope);
    if(action.action==='focus_search'&&action.expected_app==='gnome-shell')return;
    if(action.expected_app==='gnome-shell-search'&&(action.action==='type'&&action.text===raiseApp.name||action.action==='key'&&action.keys==='enter'))return;
    throw new Error('Control task scope refused: invalid raise macro step');
  }
  checkHazards(action,observed,scope);
  const app=scopeApp(scope,action.expected_app),kind=appKind(app);
  if(kind.terminal||terminalFocus(observed?.focused))throw escalationError('terminal_input',action,observed,scope);
  if(action.action==='type'){
    if(!scope.plan.texts.includes(action.text)&&!scope.plan.free_text_apps.includes(app.id))throw new Error('Control task scope refused: text is not an exact approved string');
    if((kind.messaging||kind.browser)&&/[\n\r\t]/.test(action.text))throw escalationError('sending_action',action,observed,scope);
  }
  if(action.action==='key'){
    if(dangerousKeys(action.keys)||action.keys.includes('super')||action.keys==='enter'&&(kind.messaging||kind.browser))throw escalationError(action.keys==='enter'&&(kind.messaging||kind.browser)?'sending_action':'dangerous_key',action,observed,scope);
    if(!navigation.has(action.keys)&&!scope.plan.key_combos.includes(action.keys))throw new Error('Control task scope refused: key combo was not approved');
  }
}
