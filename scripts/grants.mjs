import net from 'node:net';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT } from '../src/shared.js';
import { readRemotePolicy,writeRemotePolicy,policyPath } from '../src/node/grants/policy.js';
export async function runGrants(args,{root=ROOT,file=policyPath,print=console.log}={}){
 const [command,...flags]=args,p=readRemotePolicy(file);
 async function stop(){await new Promise(resolve=>{const socket=net.connect(path.join(root,'data/grants.sock'));const timer=setTimeout(()=>{socket.destroy();resolve();},1000);socket.on('error',()=>{clearTimeout(timer);resolve();});socket.on('connect',()=>socket.write('stop\n'));socket.on('data',()=>{clearTimeout(timer);socket.end();resolve();});});}
 if(command==='status'){print(JSON.stringify(p,null,2));return p;}
 if(command==='stop'||command==='disable'){
  p.generation++;if(command==='disable'){p.screen=false;p.control=false;}writeRemotePolicy(file,p);await stop();print(command==='disable'?'Remote grants disabled; active grants stopped.':'All local grants stopped.');return p;
 }
 if(command==='enable'){
  if(!flags.some(f=>['--screen','--control'].includes(f)))throw Error('Choose --screen and/or --control explicitly');
  for(const flag of flags)if(!/^--(?:screen|control|screen-minutes=\d+|control-minutes=\d+)$/.test(flag))throw Error('Unknown option');
  const screen=flags.find(f=>f.startsWith('--screen-minutes=')),control=flags.find(f=>f.startsWith('--control-minutes='));
  if(screen)p.screenMinutes=Number(screen.split('=')[1]);if(control)p.controlMinutes=Number(control.split('=')[1]);
  if(p.screenMinutes<1||p.screenMinutes>15||p.controlMinutes<1||p.controlMinutes>10)throw Error('Screen cap is 15 minutes; control cap is 10 minutes');
  if(flags.includes('--screen'))p.screen=true;if(flags.includes('--control'))p.control=true;p.generation++;writeRemotePolicy(file,p);await stop();print(JSON.stringify(p,null,2));return p;
 }
 throw Error('Use enable --screen [--control] [--screen-minutes=N] [--control-minutes=N], disable, status or stop');
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)await runGrants(process.argv.slice(2));
