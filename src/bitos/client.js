// Only the brain imports this module. No client/import/network activity when off.
export async function createMirrorClient(settings = {}, load = () => import('@supabase/supabase-js')) {
  const { BITOS_SUPABASE, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = settings;
  if (BITOS_SUPABASE !== '1') return null;
  const { createClient } = await load();
  return createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { fetch: (url, options = {}) => fetch(url, { ...options, signal: AbortSignal.timeout(5000) }) },
  });
}
