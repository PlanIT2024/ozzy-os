import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import path from 'node:path';
test('real GNOME result helper rejects a selected file with the same name and rechecks immediately before Enter',()=>{
 const code=`import sys,importlib.util
sys.path.insert(0,sys.argv[1]);import focus as f,search as s
A=f.Atspi
class States:
 def contains(self,value):return value in [A.StateType.SHOWING,A.StateType.VISIBLE,A.StateType.SELECTED]
class Node:
 def __init__(self,name='',children=[],role=A.Role.PANEL):self.name=name;self.children=children;self.role=role
 def get_state_set(self):return States()
 def get_name(self):return self.name
 def get_role(self):return self.role
 def get_child_count(self):return len(self.children)
 def get_child_at_index(self,i):return self.children[i]
f.search_target=lambda:None;f.in_overview=lambda n:True;f.overview_active=lambda:True
icon=Node('Obsidian',[Node(children=[Node(),Node()])],A.Role.PUSH_BUTTON)
app=Node('gnome-shell',[icon]);desktop=Node(children=[app]);A.get_desktop=lambda n:desktop
class App:
 def get_name(self):return 'Obsidian'
 def get_id(self):return 'obsidian_obsidian.desktop'
s.Gio.AppInfo.get_all=lambda:[App()]
assert s.top_result()['desktopId']=='obsidian_obsidian.desktop'
assert s.verify_result({'id':'obsidian_obsidian.desktop','name':'Obsidian'})['kind']=='application'
icon.children=[Node(children=[Node(),Node(role=A.Role.LABEL)])]
try:s.verify_result({'id':'obsidian_obsidian.desktop','name':'Obsidian'});assert False
except s.SearchResultMismatch as error:assert error.result_name=='Obsidian'
spec=importlib.util.spec_from_file_location('input_portal',sys.argv[1]+'/portal.py');p=importlib.util.module_from_spec(spec);spec.loader.exec_module(p)
focused={'app':'gnome-shell','window':'Main stage','pid':1,'windowId':2,'focusKind':'shell-search'}
p.snapshot=lambda point=None:{'focused':focused,'overviewActive':True,'target':None,'candidates':[],'hazards':[]}
p.screen.availability=lambda bus:{'monitors':[]}
x=p.Input(None);sent=[];x.key=lambda *args:sent.append(args)
try:x.action({'action':'key','keys':'enter','expected_app':'gnome-shell-search','expectedFocus':focused,'task_mode':True,'raise_step':True,'raise_target':{'id':'obsidian_obsidian.desktop','name':'Obsidian'}});assert False
except s.SearchResultMismatch:pass
assert sent==[] and x.delivery['state']=='none'
print('selected application and before-Enter check passed')`;
 assert.match(execFileSync('/usr/bin/python3',['-B','-c',code,path.resolve('src/node/input')],{encoding:'utf8'}),/selected application and before-Enter check passed/);
});
