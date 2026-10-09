export const ACTIONS = ['screenshot','mouse_move','left_click','right_click','double_click','drag','scroll','key','type','launch_app','focus_search'];
const modifiers = new Set(['ctrl','alt','shift','super']);
const aliases = { control:'ctrl', cmd:'super', meta:'super', win:'super', esc:'escape', return:'enter', del:'delete', spacebar:'space' };
const names = new Set(['enter','escape','tab','backspace','delete','space','up','down','left','right','home','end','pageup','pagedown','insert', ...Array.from({length:12},(_,i)=>`f${i+1}`)]);
export function keyNames(combo) {
  if (typeof combo !== 'string' || combo.length > 80) throw new Error('Invalid key combo');
  const keys = combo.toLowerCase().split('+').map(key => aliases[key.trim()] || key.trim());
  if (keys.length===1 && keys[0]==='super') return keys;
  if (!keys.length || keys.length > 5 || new Set(keys).size !== keys.length || keys.filter(key => !modifiers.has(key)).length !== 1 || keys.some(key => !modifiers.has(key) && !names.has(key) && !/^[a-z0-9]$/.test(key))) throw new Error('Unsupported key combo');
  if (keys.includes('ctrl') && keys.includes('alt') && (keys.includes('delete') || keys.some(key => /^f(?:[1-9]|1[0-2])$/.test(key)))) throw new Error('Blocked system key combo');
  return [...keys.filter(key=>modifiers.has(key)), ...keys.filter(key=>!modifiers.has(key))];
}
export function validateAction(input, { screenshot = true } = {}) {
  if (!input || typeof input !== 'object' || !ACTIONS.includes(input.action) || (!screenshot && input.action === 'screenshot')) throw new Error('Unsupported computer action');
  const result = { action: input.action };
  if(input.action==='launch_app'){if(typeof input.app!=='string'||!input.app.trim()||input.app.length>160||/[\\/]/.test(input.app))throw new Error('Invalid installed app name or desktop id');result.app=input.app;return result;}
  if(input.action!=='screenshot'){if(typeof input.expected_app!=='string'||!/^[a-zA-Z0-9._-]{1,160}$/.test(input.expected_app))throw new Error('Control expected_app is required for every input action');result.expected_app=input.expected_app.toLowerCase();}
  if(input.action==='focus_search'&&(result.expected_app!=='gnome-shell'||['text','keys','coordinate','end','direction','amount','app'].some(key=>input[key]!==undefined)))throw new Error('Control focus_search requires gnome-shell and no other input fields');
  const point = value => {
    if (!Array.isArray(value) || value.length !== 2 || value.some(n => !Number.isFinite(n) || n < 0 || n > 100000)) throw new Error('Invalid coordinates');
    return [...value];
  };
  if (['mouse_move','left_click','right_click','double_click','drag'].includes(input.action) || (input.action === 'scroll' && input.coordinate !== undefined)) result.coordinate = point(input.coordinate);
  if (input.action === 'drag') result.end = point(input.end);
  if (input.action === 'scroll') {
    if (!['up','down','left','right'].includes(input.direction) || !Number.isInteger(input.amount) || input.amount < 1 || input.amount > 20) throw new Error('Invalid scroll');
    result.direction = input.direction; result.amount = input.amount;
  }
  if (input.action === 'key') {
    result.keys = keyNames(input.keys).join('+');
    if(result.keys==='super' && ['text','coordinate','end','direction','amount'].some(key=>input[key]!==undefined)) throw new Error('Invalid standalone Super: no text or other action fields allowed');
  }
  if (input.action === 'type') {
    if (typeof input.text !== 'string' || !input.text.length || [...input.text].length > 500 || /[\x00-\x08\x0b-\x1f\x7f]/.test(input.text)) throw new Error('Typed text must be 1–500 characters without control codes');
    result.text = input.text;
  }
  return result;
}
export function mapPoint(point, frame) {
  if (!frame || !frame.scaled || !frame.original || !Array.isArray(frame.monitors) || !frame.monitors.length) throw new Error('Take a fresh screenshot before input');
  const [x,y] = point;
  if (x < 0 || y < 0 || x >= frame.scaled.width || y >= frame.scaled.height) throw new Error('Coordinates outside screenshot');
  const monitors = frame.monitors;
  if (monitors.some(m => ![m.x,m.y,m.width,m.height].every(Number.isFinite) || m.width <= 0 || m.height <= 0 || m.coordinateSpace !== 'logical')) throw new Error('Invalid monitor layout');
  const left = Math.min(...monitors.map(m=>m.x)), top = Math.min(...monitors.map(m=>m.y));
  const width = Math.max(...monitors.map(m=>m.x+m.width))-left, height = Math.max(...monitors.map(m=>m.y+m.height))-top;
  if (Math.abs(frame.original.width / frame.original.height - width / height) > 0.02) throw new Error('Screenshot and monitor layout disagree');
  const logicalX = left + x * width / frame.scaled.width, logicalY = top + y * height / frame.scaled.height;
  const monitor = monitors.find(m=>logicalX >= m.x && logicalX < m.x+m.width && logicalY >= m.y && logicalY < m.y+m.height);
  if (!monitor) throw new Error('Coordinates fall in a gap between monitors');
  return { x: logicalX, y: logicalY, monitor: { x: monitor.x, y: monitor.y, width: monitor.width, height: monitor.height, connector: monitor.connector } };
}
export function actionLog(input, logText = false) {
  return { action: input.action, expected_app:input.expected_app, app:input.action==='launch_app'?input.app:undefined, coordinate: input.coordinate, end: input.end, keys: input.keys, direction: input.direction, amount: input.amount, ...(input.action === 'type' ? { textLength: [...input.text].length, ...(logText ? { text: input.text } : {}) } : {}) };
}
