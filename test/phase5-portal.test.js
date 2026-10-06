import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { LinuxScreen } from '../src/node/screen/linux.js';

const env = { WAYLAND_DISPLAY: 'wayland-0', DBUS_SESSION_BUS_ADDRESS: 'session' };
test('capture diagnostics include stage, response, D-Bus failure, helper exit and exclude image stdout', async () => {
  const logs = [], pixels = 'IMAGE_BYTES_MUST_NOT_BE_LOGGED';
  const stderr = [
    { event: 'portal_response', stage: 'screenshot_request', responseCode: 2, data: pixels },
    { event: 'dbus_failure', stage: 'register_identity', dbusError: 'org.freedesktop.DBus.Error.AccessDenied', message: 'Only the focused app is allowed' },
  ].map(record => JSON.stringify(record)).join('\n');
  const screen = new LinuxScreen({ env, getEnvironment: async () => env, log: value => logs.push(value), run: async () => { throw Object.assign(new Error(pixels), { stdout: JSON.stringify({ error: 'portal_capture_failed', data: pixels }), stderr, code: 1 }); } });
  await assert.rejects(screen.capture(), /portal_capture_failed/);
  const output = logs.join('\n');
  assert.match(output, /capture attempt/); assert.match(output, /screenshot_request/);
  assert.match(output, /responseCode":2/); assert.match(output, /AccessDenied/);
  assert.match(output, /Only the focused app/); assert.match(output, /exitCode":1/);
  assert.ok(!output.includes(pixels));
  screen.diagnostics(pixels + '\n' + JSON.stringify({ message: 'data:image/png;base64,' + 'A'.repeat(1000), data: pixels }), 'capture', 1);
  assert.ok(!logs.join('\n').includes(pixels)); assert.ok(!logs.join('\n').includes('A'.repeat(1000)));
});

test('Python permission routing respects yes/no and lock state; records D-Bus errors and response codes', () => {
  const helper = path.resolve('src/node/screen/portal.py');
  const code = `import importlib.util,sys,json,io,contextlib
s=importlib.util.spec_from_file_location('portal',sys.argv[1]);p=importlib.util.module_from_spec(s);s.loader.exec_module(p)
p.CAPTURE=True
assert p.screenshot_uri((0,{'uri':'file:///test.png'}))=='file:///test.png'
for code,expected in [(1,'portal_consent_denied'),(2,'portal_capture_failed')]:
 try:p.screenshot_uri((code,{}));assert False
 except RuntimeError as error:assert str(error)==expected
lookup=p.screenshot_permission
for permission in ['yes','no']:
 p.screenshot_permission=lambda bus:permission
 calls=[]
 p.take_screenshot=lambda bus:calls.append(bus) or 'uri'
 assert p.consented_screenshot('bus')=='uri' and calls==['bus']
p.call=lambda *a,**k: ([2] if a[3]=='org.freedesktop.DBus.Properties' else [True])
try:p.availability(None);assert False
except RuntimeError as e:assert str(e)=='desktop_locked'
p.screenshot_permission=lookup
p.call=lambda *a,**k: ({p.APP:['yes']},None)
assert p.screenshot_permission(None)=='yes'
p.call=lambda *a,**k: ({},None)
assert p.screenshot_permission(None)=='unset'
error=p.Gio.DBusError.new_for_dbus_error('org.freedesktop.DBus.Error.AccessDenied','Only focused app; data:image/png;base64,'+'A'*1000)
details=p.error_details(error)
assert details['dbusError']=='org.freedesktop.DBus.Error.AccessDenied'
assert 'Only focused app' in details['message'] and 'A'*1000 not in details['message']
print('routing verified')`;
  assert.match(execFileSync('/usr/bin/python3', ['-B', '-c', code, helper], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }), /routing verified/);
});
