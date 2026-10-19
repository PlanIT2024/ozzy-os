import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID,randomBytes} from 'node:crypto';
import dotenv from 'dotenv';
import {createClient} from '@supabase/supabase-js';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
if(!process.argv.includes('--live'))throw Error('Explicit --live required: this verifies hosted RLS using temporary test sessions and an account.');
const env={...dotenv.parse(fs.readFileSync(root+'/.env')),...dotenv.parse(fs.readFileSync(root+'/.env.brain')),...dotenv.parse(fs.readFileSync(root+'/apps/dashboard/.env.local'))};
const options={auth:{persistSession:false,autoRefreshToken:false,detectSessionInUrl:false}};
const service=createClient(env.SUPABASE_URL,env.SUPABASE_SERVICE_ROLE_KEY,options);
const makeClient=()=>createClient(env.SUPABASE_URL,env.VITE_SUPABASE_PUBLISHABLE_KEY,options);
const owner=makeClient(),outsider=makeClient(),anon=makeClient();
const results=[];let temporary,channel,saved,seeded;
const check=(name,ok,detail='')=>{results.push({name,ok,detail});console.log(JSON.stringify(results.at(-1)));};
const requireResult=(r,label)=>{if(r.error)throw Error(label+': '+(r.error.code||r.error.name));return r.data;};
try {
 const old=requireResult(await service.from('bit_presence').select('*').eq('id','ozzy').maybeSingle(),'Read presence');saved=old;
 const user=requireResult(await service.auth.admin.getUserById(env.BITOS_OWNER_USER_ID),'Get owner').user;
 const link=requireResult(await service.auth.admin.generateLink({type:'magiclink',email:user.email}),'Generate test session');
 const login=requireResult(await owner.auth.verifyOtp({token_hash:link.properties.hashed_token,type:'email'}),'Owner test session');
 check('owner session identity matches brain configuration',login.user.id===env.BITOS_OWNER_USER_ID,JSON.stringify({configuredOwnerId:env.BITOS_OWNER_USER_ID,authenticatedOwnerId:login.user.id}));
 const email=`bit-presence-rls-${randomUUID()}@example.invalid`,password=randomBytes(32).toString('hex');
 temporary=requireResult(await service.auth.admin.createUser({email,password,email_confirm:true}),'Create temporary RLS subject').user.id;
 requireResult(await outsider.auth.signInWithPassword({email,password}),'Sign in temporary RLS subject');
 let resolveEvent;const event=new Promise(resolve=>{resolveEvent=resolve;});
 const marker=new Date().toISOString();
 channel=owner.channel('presence-security-'+randomUUID()).on('postgres_changes',{event:'*',schema:'public',table:'bit_presence',filter:'id=eq.ozzy'},payload=>{if(Date.parse(payload.new.updated_at)===Date.parse(marker)||payload.new.presence?.updatedAt===marker)resolveEvent(true);});
 await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Realtime join timeout')),15000);channel.subscribe(status=>{if(status==='SUBSCRIBED'){clearTimeout(timer);resolve();}else if(status==='CHANNEL_ERROR'){clearTimeout(timer);reject(Error('Realtime join failed'));}});});
 const snapshot=old?.presence||{state:'offline',mood:'chill',reaction:null,node:null,lease:null,watching:[],attention:'ambient',updatedAt:'1970-01-01T00:00:00.000Z'};
 requireResult(await service.from('bit_presence').upsert({id:'ozzy',owner_id:env.BITOS_OWNER_USER_ID,presence:snapshot,updated_at:marker}),'Brain/service write');seeded={id:'ozzy',owner_id:env.BITOS_OWNER_USER_ID,presence:snapshot,updated_at:marker};check('brain/service role can write',true);
 let timer;const received=await Promise.race([event,new Promise(resolve=>{timer=setTimeout(()=>resolve(false),10000);})]);clearTimeout(timer);
 check('owner receives live postgres change (publication membership)',received);
 const own=await owner.from('bit_presence').select('id,owner_id');check('owner can read exactly own row',!own.error&&own.data?.length===1&&own.data[0].owner_id===env.BITOS_OWNER_USER_ID);
 const other=await outsider.from('bit_presence').select('id');check('other authenticated user cannot read',!other.error&&other.data?.length===0,other.error?.code||'0 rows');
 requireResult(await service.from('bit_presence').update({owner_id:temporary}).eq('id','ozzy'),'Bind test row to other owner');
 const wrongOwner=await owner.from('bit_presence').select('id');
 check('row with another owner_id is invisible to owner session',!wrongOwner.error&&wrongOwner.data?.length===0,wrongOwner.error?.code||'0 rows');
 requireResult(await service.from('bit_presence').update({owner_id:env.BITOS_OWNER_USER_ID}).eq('id','ozzy'),'Restore owner binding');
 const anonymous=await anon.from('bit_presence').select('id');check('anonymous cannot read',anonymous.error?.code==='42501'||(!anonymous.error&&anonymous.data?.length===0),anonymous.error?.code||'0 rows');
 for(const [label,client]of [['owner',owner],['other authenticated user',outsider],['anonymous',anon]]){
  const update=await client.from('bit_presence').update({updated_at:marker}).eq('id','ozzy').select('id');check(label+' cannot update',update.error?.code==='42501',update.error?.code||'unexpected success');
  const insert=await client.from('bit_presence').insert({id:'ozzy',owner_id:env.BITOS_OWNER_USER_ID,presence:snapshot});check(label+' cannot insert',insert.error?.code==='42501',insert.error?.code||'unexpected result');
  const del=await client.from('bit_presence').delete().eq('id','ozzy').select('id');check(label+' cannot delete',del.error?.code==='42501',del.error?.code||'unexpected success');
 }
} catch(error){check('verification completed',false,error.message);}finally{
 if(channel)await owner.removeChannel(channel);
 await Promise.allSettled([owner.auth.signOut({scope:'local'}),outsider.auth.signOut({scope:'local'})]);
 if(saved||seeded){const restored=await service.from('bit_presence').upsert(saved||seeded);check('original owner binding restored',!restored.error,restored.error?.code||'');}
 if(temporary){const result=await service.auth.admin.deleteUser(temporary);check('temporary RLS subject removed',!result.error,result.error?.code||'');}
 fs.writeFileSync(root+'/docs/proof/bit-presence/security-check.json',JSON.stringify(results,null,2)+'\n');
 if(results.some(x=>!x.ok))process.exitCode=1;
}
