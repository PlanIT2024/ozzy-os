#!/usr/bin/python3
"""Read application/window geometry and focus states; never read editable text."""
import json
import sys
import gi
gi.require_version('Atspi', '2.0')
from gi.repository import Atspi, Gio, GLib
from collections import deque
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parent))
from hazards import screen_hazards, target_hazards


def inside(point, bounds):
    return bool(point and bounds and bounds['width'] > 0 and bounds['height'] > 0 and
                bounds['x'] <= point['x'] < bounds['x'] + bounds['width'] and
                bounds['y'] <= point['y'] < bounds['y'] + bounds['height'])


def overview_active():
    try:
        bus=Gio.bus_get_sync(Gio.BusType.SESSION,None)
        return bus.call_sync('org.gnome.Shell','/org/gnome/Shell','org.freedesktop.DBus.Properties','Get',GLib.Variant('(ss)',('org.gnome.Shell','OverviewActive')),None,Gio.DBusCallFlags.NONE,2000,None).unpack()[0] is True
    except Exception:return None


def in_overview(node):
    # GNOME exposes the localized Overview container, not a stable entry name.
    # Never inspect an editable node's name or value.
    parent = node.get_parent()
    for _ in range(35):
        if parent is None:return False
        states = parent.get_state_set()
        if states.contains(Atspi.StateType.MODAL) or parent.get_role() == Atspi.Role.DIALOG:return False
        if not states.contains(Atspi.StateType.EDITABLE) and parent.get_name() == GLib.dgettext('gnome-shell', 'Overview'):return True
        parent = parent.get_parent()
    return False


def search_target():
    """Find a unique editable Overview entry; no text or app input is sent."""
    Atspi.set_timeout(700,700)
    if overview_active() is not True:raise RuntimeError('shell_search_not_focused')
    desktop=Atspi.get_desktop(0);matches=[]
    for i in range(min(desktop.get_child_count(),100)):
        app=desktop.get_child_at_index(i)
        if app.get_name().lower()!='gnome-shell':continue
        for j in range(min(app.get_child_count(),100)):
            window=app.get_child_at_index(j);state=window.get_state_set()
            if not state.contains(Atspi.StateType.SHOWING) or not state.contains(Atspi.StateType.FOCUSED):continue
            pending=deque([(window,0)]);visited=0
            while pending and visited<5000:
                node,depth=pending.popleft();visited+=1;states=node.get_state_set()
                if states.contains(Atspi.StateType.SHOWING) and (states.contains(Atspi.StateType.MODAL) or node.get_role()==Atspi.Role.DIALOG):raise RuntimeError('shell_search_not_focused')
                if states.contains(Atspi.StateType.EDITABLE):
                    if states.contains(Atspi.StateType.FOCUSED) and not in_overview(node):raise RuntimeError('shell_search_not_focused')
                    if states.contains(Atspi.StateType.VISIBLE) and node.get_role() in (Atspi.Role.ENTRY,Atspi.Role.TEXT) and in_overview(node):
                        matches.append((node,{'app':'gnome-shell','window':window.get_name()[:500],
                            'pid':app.get_process_id(),'windowId':window.get_id(),'focusKind':'shell-search-target',
                            'elementId':node.get_id(),'elementPath':getattr(node,'path',None)}))
                count=node.get_child_count()
                if count>5000 or (depth>=35 and count):raise RuntimeError('control_accessibility_unavailable')
                for k in range(count):pending.append((node.get_child_at_index(k),depth+1))
            if pending:raise RuntimeError('control_accessibility_unavailable')
    if len(matches)!=1 or not matches[0][1]['elementPath'] or overview_active() is not True:raise RuntimeError('control_accessibility_unavailable')
    return matches[0]


def search_snapshot():
    _node,focused=search_target()
    return {'overviewActive':True,'focused':focused,'target':None,'targetKnown':None,'candidates':[]}


def focus_search(expected, allowed=lambda: True):
    node,focused=search_target()
    if focused!=expected:raise RuntimeError('control_focus_changed')
    if not allowed():raise RuntimeError('control_closed')
    if not node.get_component_iface() or not node.get_component_iface().grab_focus():raise RuntimeError('control_accessibility_unavailable')
    observed=snapshot()
    actual=observed.get('focused') or {}
    if observed.get('overviewActive') is not True or actual.get('focusKind')!='shell-search' or actual.get('elementPath')!=focused.get('elementPath') or actual.get('pid')!=focused.get('pid'):raise RuntimeError('control_focus_changed')
    return {'focused':actual}


def shell_entry(window):
    """Resolve Shell keyboard focus from states; Main stage need not be ACTIVE."""
    pending = deque([(window, 0)])
    matches = []
    visited = 0
    while pending and visited < 1000:
        node, depth = pending.popleft()
        visited += 1
        states = node.get_state_set()
        if depth>0 and not states.contains(Atspi.StateType.SHOWING):continue
        if (states.contains(Atspi.StateType.SHOWING) and
                states.contains(Atspi.StateType.FOCUSED) and
                states.contains(Atspi.StateType.EDITABLE) and
                node.get_role() in (Atspi.Role.ENTRY, Atspi.Role.TEXT)):
            matches.append({'elementId':node.get_id(),'elementPath':getattr(node,'path',None)})
        if depth < 35:
            for i in range(min(node.get_child_count(), 100)):
                pending.append((node.get_child_at_index(i), depth + 1))
    return matches[0] if len(matches) == 1 and not pending else None


def snapshot(point=None):
    Atspi.set_timeout(700, 700)
    desktop = Atspi.get_desktop(0)
    overview=overview_active()
    focused, shell_focused, targets = [], [], []
    windows = []
    hazard_records = {};target_flags=[]
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
                    try:hazard_records[(record['pid'],record['windowId'])]=screen_hazards(window,record['window'])
                    except Exception:hazard_records[(record['pid'],record['windowId'])]=['accessibility-incomplete']
                if app_name.lower() == 'gnome-shell' and overview is True:
                    entry = shell_entry(window)
                    if entry is not None:
                        shell_focused.append({**record, 'focusKind': 'shell-search', **entry})
                hit = False
                contains = inside(point, bounds)
                if point and component:
                    try:
                        contains |= component.contains(int(point['x']), int(point['y']), Atspi.CoordType.SCREEN)
                        if contains:
                            target_node=component.get_accessible_at_point(int(point['x']), int(point['y']), Atspi.CoordType.SCREEN)
                            hit = bool(target_node)
                            if target_node:
                                try:target_flags+=target_hazards(target_node)
                                except Exception:target_flags.append('accessibility-incomplete')
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
    if overview is True:
        if overview_active() is not True:overview=False;focus=None;focus_reason='focus-mismatch'
        elif not shell_focused:focus=None;focus_reason='missing-accessibility'
    return {'hazards':hazard_records.get((focus['pid'],focus['windowId']),[]) if focus else [],'targetHazards':sorted(set(target_flags)),'overviewActive':overview,'focused': focus, 'focusReason': focus_reason, 'target': target,
            'targetKnown': known if point else None, 'targetReason': reason,
            'targetSource': source, 'candidates': targets}


if __name__ == '__main__':
    print(json.dumps(search_snapshot() if len(sys.argv)>1 and sys.argv[1]=='--search-focus' else snapshot(json.loads(sys.argv[1]) if len(sys.argv) > 1 else None)))
