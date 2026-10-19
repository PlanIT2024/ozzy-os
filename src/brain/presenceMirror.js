import { createMirrorClient } from '../bitos/client.js';
import { createPresencePublisher } from './presence.js';
export function startPresenceMirror(hub, settings) {
  if (settings.BITOS_SUPABASE !== '1') return { close() {} };
  let client;
  return createPresencePublisher({ hub, write: async presence => {
    client ||= await createMirrorClient(settings);
    const result = await client.from('bit_presence').upsert({ id: 'ozzy', owner_id: settings.BITOS_OWNER_USER_ID, presence, updated_at: presence.updatedAt });
    if (result.error) throw result.error;
  } });
}
