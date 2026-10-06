import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import sharp from '../node/screen/sharp.js';
import { ROOT, readJSON, saveJSON } from '../shared.js';
import { canonical } from '../../relay/wire.js';
import { validateCapture } from '../node/screen/image.js';
export const GRANT_MS = 15 * 60000;
export function requestedScreenAttachment(prompt) {
  // Conservative imperative matching: quoted page instructions are not owner requests.
  if (typeof prompt !== 'string' || /\b(?:don['’]?t|do not|never)\s+(?:send|attach|post|upload|share|show)\b/i.test(prompt)) return false;
  const text = prompt.replace(/```[\s\S]*?```/g, '').replace(/"[^"\n]*"/g, '');
  return text.split(/(?:[.!?]\s+|\n)/).some(sentence => {
    sentence = sentence.trim();
    if (sentence.startsWith('>')) return false;
    const prefix = '(?:(?:also|please|and)\\s+)*(?:(?:can|could|would)\\s+you\\s+)?(?:please\\s+)?';
    return new RegExp('^' + prefix + '(?:send|attach|post|upload|share)\\s+(?:(?:me|a|the|this|that|an|scaled|screen)\\s+){0,4}(?:screenshot|screen\\s+(?:image|capture))\\b', 'i').test(sentence) ||
      new RegExp('^' + prefix + 'show\\s+me\\s+(?:(?:a|the|this|scaled)\\s+){0,3}screenshot\\b', 'i').test(sentence);
  });
}
export class ScreenGrants {
  constructor({ root = ROOT, now = () => new Date(), timezone = process.env.TZ || 'America/New_York', cap = Number(process.env.BIT_DAILY_SCREEN_CAP ?? 40) } = {}) {
    if (!Number.isInteger(cap) || cap < 0) throw new Error('Invalid screen cap');
    Object.assign(this, { root, now, timezone, cap }); this.file = path.join(root, 'data/screens.json');
    this.state = readJSON(this.file, { grants: {}, days: {} });
    this.auditFile = path.join(root, 'data/audit.log');
  }
  save() { saveJSON(this.file, this.state); }
  audit({ event = 'screen', machine, time, decision, grantId, approvalId, original, scaled, capturedAt }) {
    fs.mkdirSync(path.dirname(this.auditFile), { recursive: true, mode: 0o700 });
    fs.appendFileSync(this.auditFile, JSON.stringify({ event, time: time || this.now().toISOString(), machine, decision, grantId, approvalId, original, scaled, capturedAt }) + '\n', { mode: 0o600 });
  }
  day() { return new Intl.DateTimeFormat('en-CA', { timeZone: this.timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(this.now()); }
  status() { const day = this.day(); return { day, captures: this.state.days[day] || 0, cap: this.cap }; }
  checkCap() { if (this.status().captures >= this.cap) throw new Error('My screen-look juice is tapped for today, Ozzy. Try again tomorrow.'); }
  reserve() { this.checkCap(); const day = this.day(); this.state.days[day] = (this.state.days[day] || 0) + 1; this.save(); }
  on(thread, machine) {
    machine = canonical(machine);
    const grant = { id: randomUUID(), machine, issuedAt: this.now().toISOString(), expiresAt: new Date(+this.now() + GRANT_MS).toISOString() };
    this.state.grants[thread] = grant; this.save(); this.audit({ event: 'screen_grant', machine, decision: 'on', grantId: grant.id }); return grant;
  }
  off(thread) {
    const grant = this.state.grants[thread]; if (!grant) return;
    grant.revokedAt = this.now().toISOString(); this.save(); this.audit({ event: 'screen_grant', machine: grant.machine, decision: 'off', grantId: grant.id });
  }
  grant(thread) {
    const grant = this.state.grants[thread];
    if (!grant || grant.revokedAt) throw new Error('No screen grant in this conversation, Ozzy. Use /screen on here first.');
    if (!Number.isFinite(Date.parse(grant.expiresAt)) || +this.now() >= Date.parse(grant.expiresAt)) throw new Error('Your screen grant expired, Ozzy. Use /screen on here again.');
    return grant;
  }
  active(thread) { try { return this.grant(thread); } catch { return null; } }
  describe(thread) {
    try { const g = this.grant(thread); return `Screen access: ${g.machine} until ${new Intl.DateTimeFormat('en-US', { timeZone: this.timezone, dateStyle: 'medium', timeStyle: 'long' }).format(new Date(g.expiresAt))} · this conversation only.`; }
    catch (error) { return error.message; }
  }
  context({ hub, thread, scheduled = false, tainted = () => false, approve = async () => false, notify = async () => {}, publish, onCapture = () => {}, attachmentRequested = false }) {
    const receipts = new Map(); let published = false;
    const gate = machine => {
      if (scheduled) throw new Error('Scheduled jobs cannot capture screens, Ozzy.');
      machine = canonical(machine);
      const grant = this.grant(thread);
      if (grant.machine !== machine) throw new Error('This screen grant is for a different machine, Ozzy.');
      const node = hub.list().find(n => canonical(n.machine) === machine);
      if (!node?.online || !node.capabilities?.includes('screen')) throw new Error('That machine has no available screen capability, Ozzy.');
      return { grant, machine, displayName: node.machine };
    };
    const authorize = async (machine, { signal } = {}) => {
      let details, approvalId;
      try {
        details = gate(machine); this.checkCap();
        if (signal?.aborted) throw new Error('Screenshot cancelled');
        if (tainted()) {
          approvalId = randomUUID();
          const allowed = await approve({ tool: 'screenshot', action: 'Screenshot', description: `${details.displayName} · ${this.now().toISOString()}`, input: { machine: details.displayName, time: this.now().toISOString() }, approvalId, signal });
          if (!allowed) throw new Error('Screenshot denied or approval timed out');
          const current = gate(machine);
          if (current.grant.id !== details.grant.id) throw new Error('Screen grant changed during approval; ask again.');
          this.checkCap();
        }
        const receipt = { ...details, approvalId };
        const key = details.machine; receipts.set(key, [...(receipts.get(key) || []), receipt]);
        this.audit({ machine: key, decision: approvalId ? 'approved' : 'allowed', grantId: details.grant.id, approvalId });
        return receipt;
      } catch (error) {
        this.audit({ machine: details?.machine, decision: 'denied', grantId: details?.grant.id, approvalId }); throw error;
      }
    };
    return {
      authorize,
      capture: async machine => {
        let receipt, details;
        try {
          details = gate(machine);
          receipt = receipts.get(details.machine)?.shift();
          if (!receipt || receipt.grant.id !== details.grant.id || (tainted() && !receipt.approvalId)) {
            await authorize(machine); receipt = receipts.get(details.machine).shift();
          }
          gate(machine); this.reserve();
          const result = await hub.request(details.machine, 'screen');
          const current = gate(machine);
          if (current.grant.id !== receipt.grant.id) throw new Error('Screen grant changed while capturing; image discarded.');
          const buffer = validateCapture(result);
          const actual = await sharp(buffer, { limitInputPixels: 1568 * 1568 }).metadata();
          if (actual.width !== result.scaled.width || actual.height !== result.scaled.height || (actual.format === 'png' ? 'image/png' : actual.format === 'jpeg' ? 'image/jpeg' : '') !== result.mimeType) throw new Error('Invalid screenshot image geometry');
          const metadata = { machine: details.displayName, capturedAt: new Date(result.capturedAt).toISOString(), original: { width: result.original.width, height: result.original.height }, scaled: { width: result.scaled.width, height: result.scaled.height },
            monitors: result.monitors.map(m => ({ connector: typeof m.connector === 'string' ? m.connector.slice(0,64) : undefined, x: m.x, y: m.y, width: m.width, height: m.height, scale: m.scale, primary: m.primary, coordinateSpace: 'logical' })),
            grantId: receipt.grant.id, approvalId: receipt.approvalId };
          this.audit({ ...metadata, decision: 'captured' });
          onCapture({ machine: metadata.machine, capturedAt: metadata.capturedAt });
          await notify(`📸 looked at ${details.displayName}'s screen`);
          if (attachmentRequested && publish && !published) { published = true; await publish({ buffer, mimeType: result.mimeType, metadata }); }
          return { content: [{ type: 'text', text: JSON.stringify(metadata) }, { type: 'image', data: result.data, mimeType: result.mimeType }] };
        } catch (error) {
          this.audit({ machine: details?.machine, decision: 'failed', grantId: receipt?.grant.id, approvalId: receipt?.approvalId });
          // No node responses (or exec stdout) are logged or included in errors.
          return { isError: true, content: [{ type: 'text', text: /grant|capability|Scheduled|juice|approval|cancelled/.test(error.message) ? error.message : 'My screen sensor hit a snag, Ozzy. Check desktop consent and the graphical session; no image was shared.' }] };
        }
      },
    };
  }
}
