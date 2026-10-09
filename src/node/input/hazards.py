"""Best-effort accessibility hazard flags; no editable values leave this module."""
import re
from collections import deque
import gi
gi.require_version('Atspi','2.0')
from gi.repository import Atspi
UNSAVED=re.compile(r'\b(save changes|unsaved changes|discard changes)\b',re.I)
SENSITIVE=re.compile(r'\b(password|passcode|sign[ -]?in|log[ -]?in|2fa|two[ -]?factor|authentication|verification code|payment|checkout|credit card)\b',re.I)
SENDING=re.compile(r'^(send(?: message| email)?|submit|pay(?: now)?|purchase|buy(?: now)?|post|publish|discard|close|delete|paste)\b',re.I)

def screen_hazards(window,title):
    flags=set()
    if SENSITIVE.search(title):flags.add('sensitive_screen')
    if UNSAVED.search(title):flags.add('unsaved_work')
    pending=deque([window]);visited=0
    while pending and visited<800:
        node=pending.popleft();visited+=1
        if node is None:continue  # AT-SPI may expose holes/stale child references.
        states=node.get_state_set()
        if not states.contains(Atspi.StateType.SHOWING):continue
        role=node.get_role()
        if role==Atspi.Role.PASSWORD_TEXT:flags.add('credentials')
        if states.contains(Atspi.StateType.MODAL) or role in (Atspi.Role.DIALOG,Atspi.Role.ALERT):flags.add('unexpected_dialog')
        if not states.contains(Atspi.StateType.EDITABLE) and role in (Atspi.Role.LABEL,Atspi.Role.HEADING) and SENSITIVE.search(node.get_name()[:500]):flags.add('sensitive_screen')
        if not states.contains(Atspi.StateType.EDITABLE) and role in (Atspi.Role.LABEL,Atspi.Role.HEADING) and UNSAVED.search(node.get_name()[:500]):flags.add('unsaved_work')
        for i in range(min(node.get_child_count(),80)):pending.append(node.get_child_at_index(i))
    return sorted(flags)

def target_hazards(node):
    for _ in range(6):
        if node is None:return []
        states=node.get_state_set()
        if not states.contains(Atspi.StateType.EDITABLE) and node.get_role() in (Atspi.Role.PUSH_BUTTON,Atspi.Role.MENU_ITEM,Atspi.Role.CHECK_MENU_ITEM) and SENDING.search(node.get_name()[:100]):
            name=node.get_name()[:100]
            return ['clipboard_paste' if re.match(r'^paste\b',name,re.I) else 'unsaved_work' if re.match(r'^discard\b',name,re.I) else 'closing_action' if re.match(r'^(close|delete)\b',name,re.I) else 'sending_action']
        node=node.get_parent()
    return []


class TaskEscalation(RuntimeError):
    def __init__(self,rule,action,observed):
        super().__init__('task_escalation')
        focus=observed.get('target') if action.get('point') else observed.get('focused')
        focus=focus or {}
        self.evaluation={'rule':rule,'step':action.get('task_step',action.get('action','unknown')),
                         'app':focus.get('app','unknown'),'window':focus.get('window','unknown'),
                         'windowId':focus.get('windowId')}
