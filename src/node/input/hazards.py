"""Best-effort accessibility hazard flags; no editable values leave this module."""
import re
from collections import deque
from gi.repository import Atspi
SENSITIVE=re.compile(r'\b(password|passcode|sign[ -]?in|log[ -]?in|2fa|two[ -]?factor|authentication|verification code|payment|checkout|credit card|save changes|unsaved changes)\b',re.I)
SENDING=re.compile(r'^(send(?: message| email)?|submit|pay(?: now)?|purchase|buy(?: now)?|post|publish|discard|close|delete|paste)\b',re.I)

def screen_hazards(window,title):
    flags=set()
    if SENSITIVE.search(title):flags.add('sensitive-screen')
    pending=deque([window]);visited=0
    while pending and visited<800:
        node=pending.popleft();visited+=1
        states=node.get_state_set()
        if not states.contains(Atspi.StateType.SHOWING):continue
        role=node.get_role()
        if role==Atspi.Role.PASSWORD_TEXT:flags.add('credentials')
        if states.contains(Atspi.StateType.MODAL) or role in (Atspi.Role.DIALOG,Atspi.Role.ALERT):flags.add('unexpected-dialog')
        if not states.contains(Atspi.StateType.EDITABLE) and role in (Atspi.Role.LABEL,Atspi.Role.HEADING) and SENSITIVE.search(node.get_name()[:500]):flags.add('sensitive-screen')
        for i in range(min(node.get_child_count(),80)):pending.append(node.get_child_at_index(i))
    return sorted(flags)

def target_hazards(node):
    for _ in range(6):
        if node is None:return []
        states=node.get_state_set()
        if not states.contains(Atspi.StateType.EDITABLE) and node.get_role() in (Atspi.Role.PUSH_BUTTON,Atspi.Role.MENU_ITEM,Atspi.Role.CHECK_MENU_ITEM) and SENDING.search(node.get_name()[:100]):return ['sending-closing-or-paste']
        node=node.get_parent()
    return []
