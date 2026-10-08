export const shellSuper = action => action?.action === 'key' && action.keys === 'super' && action.text === undefined;
export function focusRefusal(reason, subject = 'target') {
  if (reason === 'overlapping-windows') return `Control ${subject}: overlapping windows; no input sent. Close overlays or focus one window and ask again.`;
  if (reason === 'focus-mismatch') return 'Control focus mismatch: target is outside the focused window; no input sent. Focus the intended application and ask again.';
  return `Control ${subject}: application does not expose usable accessibility for this operation; no input sent. Focus an accessible window or enable the app’s accessibility support and ask again.`;
}
export function assertSafeFocus(observed, action, expected, blocked = process.env.CONTROL_BLOCKED_APPS ?? 'discord') {
  const focus = observed?.focused;
  // A standalone Super is a Shell shortcut, never application text. All grant,
  // approval, lock, rate and cap checks remain in the callers.
  if (shellSuper(action)) return focus;
  if (!focus?.app || !Number.isInteger(focus.pid) || !Number.isInteger(focus.windowId)) throw new Error(focusRefusal(observed?.focusReason, 'focus'));
  const names = blocked.split(',').map(s=>s.trim().toLowerCase()).filter(Boolean);
  const denied = value => value && names.some(name=>`${value.app} ${value.window}`.toLowerCase().includes(name));
  if (denied(focus) || denied(observed.target) || observed.candidates?.some(denied)) throw new Error('Blocked application; no input sent. Discord is blocked; use lone Super or focus another app manually.');
  if (action.coordinate && !observed.targetKnown) throw new Error(focusRefusal(observed.targetReason));
  if (['key','type'].includes(action.action) && (!expected || ['app','window','pid','windowId','focusKind','elementId'].some(key=>expected[key]!==focus[key]))) throw new Error('Control focus changed since approval (focus mismatch); no input sent. Inspect focus and request a new approval.');
  return focus;
}
export function terminalFocus(focus) { return /terminal|console|kgx|ptyxis|konsole|kitty|alacritty|xterm|wezterm|tilix|terminator/i.test(focus?.app ?? ''); }
