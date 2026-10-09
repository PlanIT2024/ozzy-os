import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import path from 'node:path';
test('real focus/hazard/helper code handles Electron null children, Shell recipient and overlapping background hazards',()=>{
 const code=`import sys,importlib.util,json
sys.path.insert(0,sys.argv[1])
import focus as f, hazards as h
s=importlib.util.spec_from_file_location('input_portal',sys.argv[1]+'/portal.py');p=importlib.util.module_from_spec(s);s.loader.exec_module(p)
A=f.Atspi;show=A.StateType.SHOWING;active=A.StateType.ACTIVE;editable=A.StateType.EDITABLE;focused=A.StateType.FOCUSED
class States:
 def __init__(self,values):self.values=values
 def contains(self,value):return value in self.values
class Node:
 def __init__(self,name,role,states=[],children=[],id=1,pid=1):
  self.name=name;self.role=role;self.states=States(states);self.children=children;self.id=id;self.pid=pid;self.parent=None;self.path='/test/'+str(id)
  for child in children:
   if child is not None:child.parent=self
 def get_name(self):return self.name
 def get_role(self):return self.role
 def get_state_set(self):return self.states
 def get_child_count(self):return len(self.children)
 def get_child_at_index(self,i):return self.children[i]
 def get_parent(self):return self.parent
 def get_id(self):return self.id
 def get_process_id(self):return self.pid
 def get_component_iface(self):return self
 def get_extents(self,coord):return type('Rect',(),{'x':0,'y':0,'width':100,'height':100})()
 def contains(self,x,y,coord):return True
 def get_accessible_at_point(self,x,y,coord):return next((child for child in self.children if child is not None),self)
body=Node('DO_NOT_LOG_EDITABLE',A.Role.ENTRY,[show,editable],id=11)
obsidian=Node('Note',A.Role.FRAME,[show,active],[None,body],id=10,pid=2)
send=Node('Send private-canary',A.Role.PUSH_BUTTON,[show],id=22)
discord=Node('Discord window',A.Role.FRAME,[show],[None,send],id=20,pid=3)
apps=[Node('obsidian',A.Role.APPLICATION,[],[obsidian],pid=2),Node('Discord',A.Role.APPLICATION,[],[discord],pid=3)]
desktop=Node('Desktop',A.Role.DESKTOP_FRAME,[],apps)
f.Atspi.get_desktop=lambda n:desktop;f.overview_active=lambda:False
assert h.screen_hazards(discord,discord.name)==[]
assert h.target_hazards(send)==['sending_action']
point=f.snapshot({'x':5,'y':5});assert point['focused']['app']=='obsidian' and point['targetHazards']==[]
# A true sensitive background Discord window must not contaminate Shell search.
pw=Node('DO_NOT_LOG_PASSWORD',A.Role.PASSWORD_TEXT,[show],id=23);discord.children=[None,pw];discord.states=States([show,active]);obsidian.states=States([show])
entry=Node('DO_NOT_LOG_SEARCH',A.Role.ENTRY,[show,focused,editable],id=32)
overview=Node('Overview',A.Role.PANEL,[show],[None,entry],id=31)
shell=Node('Main stage',A.Role.WINDOW,[show],[None,overview],id=30,pid=5)
desktop.children.append(Node('gnome-shell',A.Role.APPLICATION,[],[shell],pid=5));f.overview_active=lambda:True
observed=f.snapshot();assert observed['focused']['focusKind']=='shell-search' and observed['hazards']==[]
# Invoke the resident helper's actual focus gate: Enter is evaluated on Shell.
p.snapshot=f.snapshot;x=p.Input(None)
action={'action':'key','keys':'enter','expected_app':'gnome-shell-search','expectedFocus':observed['focused'],'task_mode':True,'task_step':'raise_app/key #5'}
assert x.check_focus(action)['focused']['app']=='gnome-shell'
# The actual receiver's hazard remains a distinct escalation without matched text.
entry.children=[Node('DO_NOT_LOG_SENSITIVE',A.Role.PASSWORD_TEXT,[show],id=33)]
try:x.check_focus(action);assert False
except h.TaskEscalation as error:
 assert error.evaluation['rule']=='credentials' and error.evaluation['app']=='gnome-shell'
 assert 'DO_NOT_LOG' not in json.dumps(error.evaluation)
print('real hazard and recipient code passed')`;
 assert.match(execFileSync('/usr/bin/python3',['-B','-c',code,path.resolve('src/node/input')],{encoding:'utf8'}),/real hazard and recipient code passed/);
});
