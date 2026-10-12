// Only the brain imports this module. No client/import/network activity when off.
export async function createMirrorClient(env = process.env, load = () => import('@supabase/supabase-js')) {
  if (env.BITOS_SUPABASE !== '1') return null;
  const { createClient } = await load();
  return createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { fetch: (url, options = {}) => fetch(url, { ...options, signal: AbortSignal.timeout(5000) }) },
  });
}
