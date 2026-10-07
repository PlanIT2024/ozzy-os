export function assertSafeFocus(observed, action, expected, blocked = process.env.CONTROL_BLOCKED_APPS ?? 'discord') {
  const focus = observed?.focused;
  if (!focus?.app || !Number.isInteger(focus.pid) || !Number.isInteger(focus.windowId)) throw new Error('Control focus unavailable; no input sent');
  const names = blocked.split(',').map(s=>s.trim().toLowerCase()).filter(Boolean);
  const denied = value => value && names.some(name=>`${value.app} ${value.window}`.toLowerCase().includes(name));
  if (denied(focus) || denied(observed.target)) throw new Error('Blocked application; no input sent');
  if (action.coordinate && !observed.targetKnown) throw new Error('Control target application unknown or ambiguous; no input sent');
  if (['key','type'].includes(action.action) && (!expected || ['app','window','pid','windowId'].some(key=>expected[key]!==focus[key]))) throw new Error('Control focus changed since approval; no input sent. Inspect focus and request a new approval.');
  return focus;
}
export function terminalFocus(focus) { return /terminal|console|kgx|konsole|kitty|alacritty|xterm|wezterm|tilix|terminator/i.test(focus?.app ?? ''); }
