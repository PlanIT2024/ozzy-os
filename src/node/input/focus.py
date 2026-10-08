#!/usr/bin/python3
"""Read application/window geometry and focus states; never read editable text."""
import json
import sys
import gi
gi.require_version('Atspi', '2.0')
from gi.repository import Atspi


def inside(point, bounds):
    return bool(point and bounds and bounds['width'] > 0 and bounds['height'] > 0 and
                bounds['x'] <= point['x'] < bounds['x'] + bounds['width'] and
                bounds['y'] <= point['y'] < bounds['y'] + bounds['height'])


def shell_entry(window):
    """Resolve Shell keyboard focus from states; Main stage need not be ACTIVE."""
    pending = [(window, 0)]
    matches = []
    visited = 0
    while pending and visited < 1000:
        node, depth = pending.pop()
        visited += 1
        states = node.get_state_set()
        if (states.contains(Atspi.StateType.SHOWING) and
                states.contains(Atspi.StateType.FOCUSED) and
                states.contains(Atspi.StateType.EDITABLE) and
                node.get_role() in (Atspi.Role.ENTRY, Atspi.Role.TEXT)):
            matches.append(node.get_id())
        if depth < 15:
            for i in range(min(node.get_child_count(), 100)):
                pending.append((node.get_child_at_index(i), depth + 1))
    return matches[0] if len(matches) == 1 and not pending else None


def snapshot(point=None):
    Atspi.set_timeout(700, 700)
    desktop = Atspi.get_desktop(0)
    focused, shell_focused, targets = [], [], []
    windows = []
    incomplete = False
    for i in range(min(desktop.get_child_count(), 100)):
        app = desktop.get_child_at_index(i)
        try:
            app_name = app.get_name()[:240]
            for j in range(min(app.get_child_count(), 100)):
                window = app.get_child_at_index(j)
                states = window.get_state_set()
                if not states.contains(Atspi.StateType.SHOWING):
                    continue
                record = {'app': app_name, 'window': window.get_name()[:500],
                          'pid': app.get_process_id(), 'windowId': window.get_id()}
                component = window.get_component_iface()
                bounds = None
                if component:
                    try:
                        rect = component.get_extents(Atspi.CoordType.SCREEN)
                        bounds = {key: getattr(rect, key) for key in ('x', 'y', 'width', 'height')}
                    except Exception:
                        pass
                active = states.contains(Atspi.StateType.ACTIVE)
                if active:
                    focused.append(record)
                if app_name.lower() == 'gnome-shell':
                    entry = shell_entry(window)
                    if entry is not None:
                        shell_focused.append({**record, 'focusKind': 'shell-entry', 'elementId': entry})
                hit = False
                contains = inside(point, bounds)
                if point and component:
                    try:
                        contains |= component.contains(int(point['x']), int(point['y']), Atspi.CoordType.SCREEN)
                        if contains:
                            hit = bool(component.get_accessible_at_point(int(point['x']), int(point['y']), Atspi.CoordType.SCREEN))
                    except Exception:
                        pass  # Valid top-level bounds remain useful without an inner tree.
                overlay = states.contains(Atspi.StateType.MODAL) or window.get_role() in (
                    Atspi.Role.POPUP_MENU, Atspi.Role.TOOL_TIP)
                item = {'record': record, 'bounds': bounds, 'active': active,
                        'contains': contains, 'hit': hit, 'overlay': overlay}
                windows.append(item)
                if point and contains:
                    targets.append(record)
        except Exception:
            incomplete = True
    # Shell focused editable state takes precedence over an app's stale ACTIVE
    # window during the overview. Bind its element ID too, never infer it from Super.
    focus = (shell_focused[0] if len(shell_focused) == 1 else None) if shell_focused else (focused[0] if len(focused) == 1 else None)
    focus_reason = None if focus else ('overlapping-windows' if len(focused) > 1 or len(shell_focused) > 1 else 'missing-accessibility')
    active_hit = next((w for w in windows if w['record'] == focus and w['contains']), None)
    target, source, reason = None, None, None
    known = False
    if point:
        if incomplete:
            reason = 'missing-accessibility'
        elif active_hit and not any(w['contains'] and w['overlay'] and w['record'] != focus for w in windows):
            # Ordinary inactive windows are background candidates, not proof of
            # an overlay. Do not require the focused Electron frame's inner tree.
            target, known = focus, True
            source = 'accessible-hit' if active_hit['hit'] else 'focused-window-extents'
        elif len(targets) > 1 or active_hit:
            reason = 'overlapping-windows'
        elif targets:
            target, reason = targets[0], 'focus-mismatch'
        else:
            reason = 'missing-accessibility'
    return {'focused': focus, 'focusReason': focus_reason, 'target': target,
            'targetKnown': known if point else None, 'targetReason': reason,
            'targetSource': source, 'candidates': targets}


if __name__ == '__main__':
    print(json.dumps(snapshot(json.loads(sys.argv[1]) if len(sys.argv) > 1 else None)))
