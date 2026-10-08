export function deliveryPlan(action) {
  return {state:'none',count:0,total:action?.action==='type'?[...(action.text??'')].length:action?.action==='key'?String(action.keys??'').split('+').filter(Boolean).length:0,unit:action?.action==='type'?'characters':'key presses'};
}
export function validDelivery(value) { return value && ['none','partial','all','uncertain'].includes(value.state) && Number.isInteger(value.count) && Number.isInteger(value.total) && value.count>=0 && value.total>=value.count && value.total<=500 && ['characters','key presses'].includes(value.unit); }
export function deliveryText(value) { return validDelivery(value)?`Delivery: ${value.state} (${value.count}/${value.total} ${value.unit} confirmed${value.state==='uncertain'?'; last in-flight delivery cannot be confirmed':''}).`:'Delivery: uncertain; the node did not return a delivery receipt. Stop and check the screen; do not retry.'; }
