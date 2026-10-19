import fs from 'node:fs';
import path from 'node:path';
import { ROOT, saveJSON } from '../../shared.js';
export const policyPath = path.join(ROOT,'data/remote-grants.json');
export function readRemotePolicy(file=policyPath) {
 try {
  const p=JSON.parse(fs.readFileSync(file,'utf8'));
  if(!Number.isSafeInteger(p.generation)||p.generation<0||typeof p.screen!=='boolean'||typeof p.control!=='boolean'||!Number.isInteger(p.screenMinutes)||p.screenMinutes<1||p.screenMinutes>15||!Number.isInteger(p.controlMinutes)||p.controlMinutes<1||p.controlMinutes>10)throw Error();
  return p;
 } catch {return {screen:false,control:false,screenMinutes:15,controlMinutes:10,generation:0};}
}
export function writeRemotePolicy(file,p) {saveJSON(file,p);fs.chmodSync(file,0o600);}
