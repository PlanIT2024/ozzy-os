export const MOODS={chill:["#5ef0ff","#b45cff"],hype:["#ffc04a","#ff4f7b"],chaotic:["#4fffb0","#ff4fd8"],gremlin:["#b6ff3b","#16c79a"],sage:["#9a8bff","#3b5bff"]};
export const REACT={celebrate:1.6,wince:1.2,curious:2.0,unsure:4.0};
const DETAIL={full:284,simple:64,min:28};
const MO={
  smile:"M127 170 Q150 166 173 170 Q172 200 150 201 Q128 200 127 170Z",
  big:"M120 166 Q150 160 180 166 Q178 208 150 209 Q122 208 120 166Z",
  o:"M143 182 a7 8 0 1 0 14 0 a7 8 0 1 0 -14 0Z",
  flat:"M134 180 L166 180 L166 184 L134 184Z",
  focus:"M136 178 Q150 186 164 178 L164 182 Q150 190 136 182Z",
  worry:"M134 188 Q150 176 166 188 L166 192 Q150 180 134 192Z",
  sleep:"M136 180 Q150 190 164 180 L164 183 Q150 193 136 183Z"
};
const UNSURE_PIXELS=[0,1,2,5,7];      // rough "?" in the 3x3 grid
const THINK_PATH=[0,1,2,5,8,7,6,3];   // pixel orbit order


function brow(cx,lift,tilt,side){const b=100-lift,x1=cx-18,x2=cx+18,inner=side?x1:x2;const y1=b+(inner===x1?tilt:0),y2=b+(inner===x2?tilt:0);return `M${x1} ${y1} Q${cx} ${b-10} ${x2} ${y2}`}


export const detailFor = size => size >= 96 ? 'full' : size >= 40 ? 'simple' : 'min';
export function faceFor({ state = 'idle', mood = 'chill', reaction = null, leaseLeft = 0, leaseTotal = 1, t = 0, size = 300, reducedMotion = false, pointer = {x:0,y:0}, yawning = false, capturePulse = null }) {
  if (!Object.hasOwn(MOODS,mood)) mood = 'chill';
  if (reducedMotion) t = 1;
  const detail = detailFor(size), attrs = {};
  const $ = id => ({ setAttribute(key,value) { (attrs[id] ||= {})[key] = value; } });
  const vis = (id,on) => $(id).setAttribute('visibility',on?'visible':'hidden');
  const cells = [0,1].map(e=>Array.from({length:9},(_,i)=>$('p'+e+'_'+i)));
  const sp = Array.from({length:16},(_,i)=>({c:$('s'+i),a:i*2.39996,r:122+(i*13%24),z:1+i%3,p:i*0.73}));
  const C=2*Math.PI*112,EX=[112,188],EY=128;
  const kind = typeof reaction === 'string' ? reaction : reaction?.kind;
  const rp = typeof reaction === 'object' ? Math.min(1,Math.max(0,reaction?.progress || 0)) : 0;
  const rx = !['approve','offline'].includes(state) && Object.hasOwn(REACT,kind) ? kind : null;
  let [c1,c2]=MOODS[mood];
  if(state==="approve"){c1="#ffd166";c2="#ff8a3d"}
  if(state==="offline"){c1="#6b6f80";c2="#3a3e50"}
  $("color1").setAttribute("stop-color",c1);$("color2").setAttribute("stop-color",c2);

  let bob=state==="offline"?8:Math.sin(t*1.3)*5;
  if(rx==="celebrate")bob-=14*Math.sin(Math.PI*rp);
  const shake=rx==="wince"?Math.sin(t*45)*3*(1-rp):0;
  $("body").setAttribute("transform",`translate(${shake} ${bob})`);
  $("floor").setAttribute("opacity",state==="offline"?0.15:0.3-bob*0.02);$("floor").setAttribute("fill",c2);

  // Ring
  let op=1,da="none",off=0,tm="";
  if(state==="listen")op=0.55+0.45*Math.sin(t*3);
  if(state==="think"){da=C*0.22+" "+C;off=-t*300}
  if(state==="agent"){da="16 10";off=-t*45}
  if(state==="lease"){const L=Math.max(1,leaseTotal),left=Math.max(0,leaseLeft);da=C*left/L+" "+C;tm=Math.floor(left/60)+":"+String(Math.floor(left%60)).padStart(2,"0")}
  if(state==="approve")op=Math.floor(t*2)%2?1:0.35;
  if(state==="offline")op=0.5;
  ["ring","glow"].forEach(id=>{const r=$(id);r.setAttribute("stroke-dasharray",da);r.setAttribute("stroke-dashoffset",off)});
  $("ring").setAttribute("opacity",op);$("glow").setAttribute("opacity",op*0.55);
  $("ring").setAttribute("stroke-width",detail==="min"?14:detail==="simple"?8:5);

  // One stronger scan per node-reported screenshot, independent of the grant.
  const scan = capturePulse && !['approve','offline'].includes(state);
  const pulseProgress = capturePulse?.progress || 0;
  if (scan) {
    $("ring").setAttribute('stroke-width', (detail==='min'?14:detail==='simple'?8:5) + 4*(1-pulseProgress));
    $("glow").setAttribute('opacity', 0.95 - 0.4*pulseProgress);
  }
  // Eyes
  const blink=["idle","listen","lease","agent"].includes(state)&&!rx&&(t%4.2)<0.13;
  let h={screen:22,approve:40,offline:3}[state]||34;
  if(blink)h=3;
  if(rx==="wince")h=16;
  if(rx==="curious"||rx==="unsure")h=34;
  ["fL","fR"].forEach(id=>{const f=$(id);f.setAttribute("height",h);f.setAttribute("y",EY-h/2);f.setAttribute("stroke",c2)});
  let dx=state==="idle"?pointer.x:Math.sin(t*0.6)*3,dy=state==="idle"?pointer.y:0;
  if(state==="agent"){dx=6;dy=4}
  if(state==="approve"||state==="listen")dx=0;
  if(rx==="curious")dx=6;
  if(rx==="unsure")dx=0;
  cells.forEach((row,e)=>row.forEach((r,i)=>{
    const cx=EX[e];let on=1;
    if(state==="think")on=i===THINK_PATH[Math.floor(t*8)%8]?1:0.12;
    if(state==="screen")on=Math.floor(i/3)===Math.floor(t*3)%3?0.7:0.25;
    if(scan)on=Math.floor(i/3)===Math.min(2,Math.floor(pulseProgress*3))?1:0.08;
    if(state==="listen")on=0.6+0.4*Math.sin(t*3+i);
    if(rx==="wince")on=Math.floor(i/3)===1?1:0;
    if(rx==="unsure")on=UNSURE_PIXELS.includes(i)?1:0.15;
    if(h<14)on=0;
    let size=6,x=cx-10.5+(i%3)*7.5+(state==="think"?0:dx),y=EY-10.5+Math.floor(i/3)*7.5+dy;
    if(detail==="min"){if(i!==4)on=0;size=24;x=cx-12;y=EY-12;if(state==="offline")on=0.4}
    r.setAttribute("width",size);r.setAttribute("height",size);
    r.setAttribute("x",x);r.setAttribute("y",y);r.setAttribute("fill",c1);r.setAttribute("opacity",on);
  }));

  // Brows
  const B={listen:[5,0],approve:[8,-6],agent:[-1,6],think:[2,4],screen:[-2,5],offline:[-4,0]}[state]||[0,0];
  let lL=B[0],lR=B[0];
  if(rx==="celebrate"){lL+=6;lR+=6}
  if(rx==="curious")lR+=8;
  if(rx==="unsure")lL+=7;
  $("bL").setAttribute("d",brow(EX[0],lL,B[1],0));$("bR").setAttribute("d",brow(EX[1],lR,B[1],1));
  $("bL").setAttribute("stroke",c1);$("bR").setAttribute("stroke",c1);

  // Mouth
  let m={listen:"o",think:"flat",agent:"focus",lease:"focus",screen:"flat",approve:"worry",offline:"sleep"}[state]||(mood==="hype"||mood==="chaotic"?"big":"smile");
  if(rx)m={celebrate:"big",wince:"worry",curious:"o",unsure:"flat"}[rx];

  if(detail==="simple"&&state!=="offline"&&state!=="approve")m="smile";
  if(yawning && state === "idle" && !rx)m="o";
  $("mouth").setAttribute("d",MO[m]);

  // Sparkles
  const spd=state==="think"?0.8:mood==="hype"||mood==="chaotic"?0.25:0.05;
  sp.forEach((s,i)=>{
    const a=s.a+t*spd*(i%2?1:-1),rr=s.r+(rx==="celebrate"?30*rp:0);
    s.c.setAttribute("cx",150+Math.cos(a)*rr);s.c.setAttribute("cy",145+bob+Math.sin(a)*rr);
    s.c.setAttribute("r",s.z);s.c.setAttribute("fill",i%2?c1:c2);
    let o=state==="offline"?0.1:0.35+0.6*Math.abs(Math.sin(t*1.5+s.p));
    if(rx==="celebrate")o=Math.min(1,o+0.4*(1-rp));
    s.c.setAttribute("opacity",o);
  });

  // Level of detail
  const full=detail==="full",min=detail==="min";
  ["spk","bL","bR","hl2","rim","glow","inner","timer"].forEach(id=>vis(id,full));
  ["fL","fR","mouth"].forEach(id=>vis(id,!min)); vis("hl1",full); vis("floor",full);
  $("timer").textContent=tm;$("timer").setAttribute("fill",c1);

  if (reducedMotion) { attrs.body.transform='translate(0 0)'; attrs.ring['stroke-dashoffset']=0; attrs.glow['stroke-dashoffset']=0; }
  return { detail, ring:attrs.ring, eye:[attrs.fL,attrs.fR], pupil:cells.map((_,e)=>Array.from({length:9},(_,i)=>attrs['p'+e+'_'+i])), brow:[attrs.bL,attrs.bR], mouth:attrs.mouth, sparkle:sp.map((_,i)=>attrs['s'+i]), attrs, timer:tm };
}
