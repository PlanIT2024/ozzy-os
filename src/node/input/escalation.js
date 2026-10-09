// Reason codes and recipient metadata only; never retain matched accessible text.
export function hazardRule(value){return ({'sensitive-screen':'sensitive_screen',credentials:'credentials','unexpected-dialog':'unexpected_dialog','unsaved-work':'unsaved_work','sending-closing-or-paste':'sending_action','accessibility-incomplete':'accessibility_incomplete'})[value]||value.replaceAll('-','_');}
export function escalationError(rule,action,observed={},scope={}){
 const receiving=action.coordinate?observed.target:observed.focused;
 const evaluation=safeEvaluation({rule,step:`${scope.raiseApp?'raise_app/':''}${action.action} #${(scope.steps||0)+1}`,app:receiving?.app||action.expected_app||action.app||'unknown',window:receiving?.window||'(no input recipient)',windowId:receiving?.windowId});
 return Object.assign(new Error(evaluationText(evaluation)),{evaluation});
}
export function checkHazards(action,observed,scope){
 const flags=[...(observed?.hazards||[]),...(observed?.targetHazards||[])];
 if(flags.length)throw escalationError(hazardRule(flags[0]),action,observed,scope);
}
const rules=new Set(['sensitive_screen','credentials','unsaved_work','unexpected_dialog','sending_action','closing_action','clipboard_paste','accessibility_incomplete','terminal_input','dangerous_key']);
export function safeEvaluation(value){
 if(!value||!rules.has(value.rule))return;
 const safe=text=>String(text??'unknown').replace(/data:image\/\S+|[A-Za-z0-9+/=]{80,}|(?:token|password|secret|authorization)\s*[:=]\s*\S+/ig,'[redacted]').replace(/[\x00-\x1f]/g,' ').slice(0,500);
 return {rule:value.rule,step:safe(value.step),app:safe(value.app),window:safe(value.window),...(Number.isInteger(value.windowId)?{windowId:value.windowId}:{})};
}
export function evaluationText(value){return `Control task escalation required: ${value.rule}; step ${value.step}; evaluated ${value.app} — ${value.window}. Stop and ask.`;}
