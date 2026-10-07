#!/usr/bin/python3
"""Read window metadata only. Never inspect editable text or send input."""
import json
import sys
import gi
gi.require_version('Atspi', '2.0')
from gi.repository import Atspi


def snapshot(point=None):
    Atspi.set_timeout(700, 700)
    desktop = Atspi.get_desktop(0)
    focused = []
    targets = []
    for i in range(min(desktop.get_child_count(), 100)):
        app = desktop.get_child_at_index(i)
        try:
            for j in range(min(app.get_child_count(), 100)):
                window = app.get_child_at_index(j)
                states = window.get_state_set()
                if not states.contains(Atspi.StateType.SHOWING):
                    continue
                record = {'app': app.get_name()[:240], 'window': window.get_name()[:500],
                          'pid': app.get_process_id(), 'windowId': window.get_id()}
                if states.contains(Atspi.StateType.ACTIVE):
                    focused.append(record)
                if point:
                    component = window.get_component_iface()
                    if component and component.contains(int(point['x']), int(point['y']), Atspi.CoordType.SCREEN):
                        child = component.get_accessible_at_point(int(point['x']), int(point['y']), Atspi.CoordType.SCREEN)
                        if child:
                            targets.append(record)
        except Exception:
            # A disappearing/inaccessible window must not become a guessed target.
            continue
    # AT-SPI cannot establish stacking of overlapping application windows on
    # Wayland. An ambiguous hit is explicitly unknown, never selected by belief.
    focus = focused[0] if len(focused) == 1 else None
    target = targets[0] if len(targets) == 1 else None
    # Only the active window has an independently established foreground identity.
    # A lone inactive hit could be obscured by an app absent from accessibility.
    known = bool(target and focus and target == focus)
    return {'focused': focus, 'target': target, 'targetKnown': known if point else None}


if __name__ == '__main__':
    print(json.dumps(snapshot(json.loads(sys.argv[1]) if len(sys.argv) > 1 else None)))
