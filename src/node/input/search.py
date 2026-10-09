"""GNOME 50 default-result identity; reads only app/file names, never query text."""
from gi.repository import Atspi, Gio

def app_icon(node):
    # Installed GNOME 50 AppIcon: one icon-container with BaseIcon + empty
    # running-dot widget. Remote list results have title/description boxes.
    if node.get_child_count()!=1:return False
    container=node.get_child_at_index(0)
    if container is None or container.get_child_count()!=2:return False
    icon,dot=container.get_child_at_index(0),container.get_child_at_index(1)
    return bool(icon and dot and icon.get_role()==Atspi.Role.PANEL and dot.get_role()==Atspi.Role.PANEL and dot.get_child_count()==0)

def top_result():
    from focus import search_target, in_overview, overview_active
    search_target()  # Requires the unique, visible editable Overview entry.
    desktop=Atspi.get_desktop(0);matches=[]
    for i in range(min(desktop.get_child_count(),100)):
        app=desktop.get_child_at_index(i)
        if app is None or app.get_name().lower()!='gnome-shell':continue
        pending=[app];visited=0
        while pending and visited<5000:
            node=pending.pop(0);visited+=1
            if node is None:continue
            state=node.get_state_set()
            if node.get_role()==Atspi.Role.PUSH_BUTTON and state.contains(Atspi.StateType.SELECTED) and state.contains(Atspi.StateType.SHOWING) and state.contains(Atspi.StateType.VISIBLE) and in_overview(node):
                name=node.get_name()[:240]
                ids={a.get_id() for a in Gio.AppInfo.get_all() if a.get_name()==name and a.get_id() and a.get_id().endswith('.desktop')} if app_icon(node) else set()
                matches.append({'name':name,'kind':'application' if app_icon(node) else 'file-or-other','desktopId':next(iter(ids)) if len(ids)==1 else None,'path':getattr(node,'path',None)})
            if not state.contains(Atspi.StateType.EDITABLE):
                for j in range(min(node.get_child_count(),100)):pending.append(node.get_child_at_index(j))
        if pending:raise RuntimeError('control_accessibility_unavailable')
    if overview_active() is not True or len(matches)!=1:raise RuntimeError('search_result_unavailable')
    return matches[0]

class SearchResultMismatch(RuntimeError):
    def __init__(self,result):
        super().__init__('search_result_mismatch')
        self.result_name=result.get('name','unknown')[:240]

def verify_result(target):
    result=top_result()
    if result['kind']!='application' or result['desktopId']!=target.get('id') or result['name']!=target.get('name'):raise SearchResultMismatch(result)
    return result
