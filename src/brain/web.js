import path from 'node:path';
import { lookup } from 'node:dns/promises';
import { isIP, BlockList } from 'node:net';
import { readJSON, saveJSON } from '../shared.js';
const blocked = new BlockList();
for (const [ip, bits] of [['0.0.0.0',8],['10.0.0.0',8],['100.64.0.0',10],['127.0.0.0',8],['169.254.0.0',16],['172.16.0.0',12],['192.0.0.0',24],['192.0.2.0',24],['192.88.99.0',24],['192.168.0.0',16],['198.18.0.0',15],['198.51.100.0',24],['203.0.113.0',24],['224.0.0.0',3]]) blocked.addSubnet(ip,bits,'ipv4');
const global6 = new BlockList(); global6.addSubnet('2000::',3,'ipv6');
for (const [ip,bits] of [['2001::',23],['2001:db8::',32],['2002::',16],['3fff::',20]]) blocked.addSubnet(ip,bits,'ipv6');
export async function publicURL(raw, resolve = lookup) {
  if (typeof raw !== 'string' || /[\x00-\x20\x7f]/.test(raw)) throw new Error('Malformed URL');
  const url = new URL(raw), host = url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || isIP(host) || host === 'localhost' || host.endsWith('.localhost') || !host.includes('.')) throw new Error('My web sensor only accepts public HTTP(S) hostnames, Ozzy.');
  const addresses = await resolve(host, { all: true, verbatim: true });
  if (!addresses.length || addresses.some(({ address }) => {
    const family = isIP(address);
    return !family || (family === 4 ? blocked.check(address,'ipv4') : !global6.check(address,'ipv6') || blocked.check(address,'ipv6'));
  })) throw new Error('My web sensor blocks non-public addresses, Ozzy.');
  return raw;
}
export function messageURLs(text) { return text.match(/https?:\/\/[^\s<>"`]+/g) || []; }
export class WebLedger {
  constructor({ root, now = () => new Date(), dailySearchCap = Number(process.env.BIT_DAILY_SEARCH_CAP ?? 50), dailyFetchCap = Number(process.env.BIT_DAILY_FETCH_CAP ?? 100) }) {
    if (![dailySearchCap,dailyFetchCap].every(n => Number.isInteger(n) && n >= 0)) throw new Error('Invalid web cap');
    Object.assign(this,{now,dailySearchCap,dailyFetchCap}); this.file = path.join(root,'data/web.json');
    this.state = readJSON(this.file,{sessions:{},days:{},months:{}});
  }
  save() { saveJSON(this.file,this.state); }
  session(id) { return this.state.sessions[id] ||= { tainted:false, urls:[] }; }
  owner(id,prompt) { const s=this.session(id); s.urls=[...new Set([...s.urls,...messageURLs(prompt)])]; this.save(); }
  day() { const p = new Intl.DateTimeFormat('en-CA',{timeZone:process.env.TZ || 'America/New_York',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(this.now()); return ['year','month','day'].map(t=>p.find(x=>x.type===t).value).join('-'); }
  counts(table,key) { return table[key] ||= {search:0,fetch:0}; }
  status() { const day=this.day(), month=day.slice(0,7); return {day,month,daily:this.counts(this.state.days,day),monthly:this.counts(this.state.months,month),searchCap:this.dailySearchCap,fetchCap:this.dailyFetchCap,estimatedSearchUSD:Math.max(0,this.counts(this.state.months,month).search - (this.state.covered?.[month] || 0)) * .01, sdkSearches:this.state.covered?.[month] || 0}; }
  reserve(tool) { const kind=tool==='WebSearch'?'search':'fetch', s=this.status(); if(s.daily[kind] >= (kind==='search'?s.searchCap:s.fetchCap)) throw new Error(`My web ${kind} juice is tapped for today, Ozzy. Try again tomorrow.`); s.daily[kind]++; s.monthly[kind]++; this.save(); }
  reportedCost(id, modelUsage) {
    const count = Object.values(modelUsage || {}).reduce((n,m) => n + (m.webSearchRequests || 0), 0);
    this.state.sdkSessions ||= {}; this.state.covered ||= {};
    const previous = this.state.sdkSessions[id] || 0;
    const month = this.status().month;
    this.state.covered[month] = (this.state.covered[month] || 0) + Math.max(0, count - previous);
    this.state.sdkSessions[id] = Math.max(previous,count); this.save();
  }
  result(id,tool,output) {
    const s=this.session(id); s.tainted=true;
    if (tool === 'WebSearch' && Number.isInteger(output?.searchCount) && output.searchCount > 1) { const counts=this.status(); counts.daily.search += output.searchCount - 1; counts.monthly.search += output.searchCount - 1; }
    // Only structured search-hit URLs are provenance, never model commentary.
    if(tool==='WebSearch') for(const group of output?.results || []) if(typeof group==='object') for(const hit of group.content || []) if(typeof hit.url==='string') s.urls.push(hit.url);
    s.urls=[...new Set(s.urls)]; this.save();
  }
}
