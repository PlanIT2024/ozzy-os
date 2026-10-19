import { faceFor, REACT } from './face.js';
export const STATE_WORDS = { idle:'idle', listen:'listening', think:'thinking', agent:'running a task', lease:'controlling a machine', screen:'watching screen', approve:'needs approval', offline:'offline' };
export class BitOrb extends (globalThis.HTMLElement || class {}) {
  static observedAttributes = ['state','mood','reaction','reaction-at','lease-ends-at','lease-total','node','capture-pulse-at'];
  constructor() {
    super(); this.attachShadow({mode:'open'});
    this.shadowRoot.innerHTML = `<style>:host{display:inline-block;width:48px;height:48px}svg{display:block;overflow:visible}</style>    <svg  viewBox="0 0 300 300" width="100%" height="100%" role="img" aria-label="bIT">
      <defs>
        <linearGradient id="rg" x1="0" y1="0" x2="1" y2="1"><stop id="color1" offset="0" stop-color="#5ef0ff"/><stop id="color2" offset="1" stop-color="#b45cff"/></linearGradient>
        <filter id="gl" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="6"/></filter>
      </defs>
      <ellipse id="floor" cx="150" cy="284" rx="70" ry="6" fill="#3d6bff" opacity="0.35" filter="url(#gl)"/>
      <g id="spk"><circle id="s0"/><circle id="s1"/><circle id="s2"/><circle id="s3"/><circle id="s4"/><circle id="s5"/><circle id="s6"/><circle id="s7"/><circle id="s8"/><circle id="s9"/><circle id="s10"/><circle id="s11"/><circle id="s12"/><circle id="s13"/><circle id="s14"/><circle id="s15"/></g>
      <g id="body">
        <circle id="glow" cx="150" cy="145" r="112" fill="none" stroke="url(#rg)" stroke-width="16" filter="url(#gl)" opacity="0.6" transform="rotate(-90 150 145)"/>
        <circle id="ring" cx="150" cy="145" r="112" fill="none" stroke="url(#rg)" stroke-width="5" stroke-linecap="round" transform="rotate(-90 150 145)"/>
        <circle id="inner" cx="150" cy="145" r="105" fill="none" stroke="url(#rg)" stroke-width="1.2" opacity="0.45"/>
        <circle cx="150" cy="145" r="100" fill="#040407"/>
        <circle cx="150" cy="145" r="97" fill="none" stroke="#1b1e30" stroke-width="2"/>
        <ellipse id="hl1" cx="128" cy="64" rx="24" ry="7" fill="#fff" opacity="0.85" transform="rotate(-14 128 64)"/>
        <ellipse id="hl2" cx="160" cy="58" rx="6" ry="2.5" fill="#fff" opacity="0.6"/>
        <g id="rim">
          <path d="M66 175 Q72 205 92 222" fill="none" stroke="#2a2d40" stroke-width="4" stroke-linecap="round"/>
          <path d="M234 175 Q228 205 208 222" fill="none" stroke="#2a2d40" stroke-width="4" stroke-linecap="round"/>
        </g>
        <path id="bL" fill="none" stroke-width="4.5" stroke-linecap="round"/>
        <path id="bR" fill="none" stroke-width="4.5" stroke-linecap="round"/>
        <rect id="fL" x="89" width="46" rx="2" fill="#0a0a14" stroke-width="2.2"/>
        <rect id="fR" x="165" width="46" rx="2" fill="#0a0a14" stroke-width="2.2"/>
        <g id="pup"><rect id="p0_0" rx="1"/><rect id="p0_1" rx="1"/><rect id="p0_2" rx="1"/><rect id="p0_3" rx="1"/><rect id="p0_4" rx="1"/><rect id="p0_5" rx="1"/><rect id="p0_6" rx="1"/><rect id="p0_7" rx="1"/><rect id="p0_8" rx="1"/><rect id="p1_0" rx="1"/><rect id="p1_1" rx="1"/><rect id="p1_2" rx="1"/><rect id="p1_3" rx="1"/><rect id="p1_4" rx="1"/><rect id="p1_5" rx="1"/><rect id="p1_6" rx="1"/><rect id="p1_7" rx="1"/><rect id="p1_8" rx="1"/></g>
        <path id="mouth" fill="#fff"/>
        <text id="timer" x="150" y="226" text-anchor="middle" style="font-size:12px;font-family:ui-monospace,monospace"></text>
      </g>
    </svg>`;
    this.parts = Object.fromEntries([...this.shadowRoot.querySelectorAll('[id]')].map(el=>[el.id,el]));
    this.pointer={x:0,y:0}; this.visible=true; this.size=48; this.changedAt=Date.now(); this.last=0;
    this.motion=matchMedia('(prefers-reduced-motion: reduce)');
    this.onPointer=e=>{this.pointer={x:(e.clientX/innerWidth-.5)*8,y:(e.clientY/innerHeight-.5)*6};};
    this.wake=()=>{cancelAnimationFrame(this.frame);this.draw();if(!document.hidden&&this.visible)this.frame=requestAnimationFrame(this.tick);};
    this.tick=stamp=>{if(document.hidden||!this.visible)return;const state=this.data().state;if(stamp-this.last>=(state==='idle'?100:1000/30)){this.last=stamp;this.draw();}this.frame=requestAnimationFrame(this.tick);};
  }
  connectedCallback() {
    this.setAttribute('role','img');
    window.addEventListener('pointermove',this.onPointer); document.addEventListener('visibilitychange',this.wake); this.motion.addEventListener('change',this.wake);
    this.resize=new ResizeObserver(entries=>{this.size=Math.min(entries[0].contentRect.width,entries[0].contentRect.height);this.wake();});this.resize.observe(this);
    this.observer=new IntersectionObserver(entries=>{this.visible=entries[0].isIntersecting;this.wake();});this.observer.observe(this);this.wake();
  }
  disconnectedCallback(){cancelAnimationFrame(this.frame);this.resize?.disconnect();this.observer?.disconnect();window.removeEventListener('pointermove',this.onPointer);document.removeEventListener('visibilitychange',this.wake);this.motion.removeEventListener('change',this.wake);}
  attributeChangedCallback(){this.changedAt=Date.now();this.wake?.();}
  set presence(value) {
    const key=JSON.stringify({...value,updatedAt:undefined});
    if(key!==this.key){this.changedAt=Date.now();this.key=key;}
    this._presence=value;this.wake();
  }
  get presence(){return this._presence;}
  data(){return this._presence || {state:this.getAttribute('state')||'idle',mood:this.getAttribute('mood')||'chill',reaction:{kind:this.getAttribute('reaction'),at:this.getAttribute('reaction-at')},lease:{endsAt:this.getAttribute('lease-ends-at'),totalSec:Number(this.getAttribute('lease-total'))},capturePulse:{at:this.getAttribute('capture-pulse-at')},node:this.getAttribute('node')};}
  draw(){
    const p=this.data(),now=Date.now();
    const state=p.updatedAt && now-Date.parse(p.updatedAt)>90000?'offline':p.state;
    const age=(now-Date.parse(p.reaction?.at))/1000;
    const reaction=age>=0&&age<REACT[p.reaction?.kind]?{kind:p.reaction.kind,progress:age/REACT[p.reaction.kind]}:null;
    const label='bIT: '+(STATE_WORDS[state]||'idle')+(p.node&&['agent','lease','screen'].includes(state)?' on '+p.node:'');
    if(this.title!==label){this.title=label;this.setAttribute('aria-label',label);}
    const pulseAge=(now-Date.parse(p.capturePulse?.at))/1000;
    const capturePulse=pulseAge>=0 && pulseAge<1.2 ? {progress:pulseAge/1.2} : null;
    const f=faceFor({capturePulse,state,mood:p.mood,reaction,leaseLeft:Math.max(0,(Date.parse(p.lease?.endsAt)-now)/1000)||0,leaseTotal:p.lease?.totalSec||1,t:now/1000,size:this.size,reducedMotion:this.motion.matches,pointer:this.pointer,yawning:now-this.changedAt>600000&&(now-this.changedAt)%60000<2500});
    for(const [id,attrs]of Object.entries(f.attrs))for(const [key,value]of Object.entries(attrs))this.parts[id]?.setAttribute(key,String(value));
    this.parts.timer.textContent=f.timer;
  }
}
if(globalThis.customElements && !customElements.get('bit-orb'))customElements.define('bit-orb',BitOrb);
