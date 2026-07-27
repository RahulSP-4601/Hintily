import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { corsHeaders } from '../_shared/cors.ts';

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (request.method !== 'DELETE') return json(405, { error: 'method_not_allowed' });

  const authorization = request.headers.get('Authorization');
  if (!authorization?.startsWith('Bearer ')) return json(401, { error: 'unauthorized' });

  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY');
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!supabaseUrl || !anonKey || !serviceRoleKey) return json(503, { error: 'service_unconfigured' });

  const userClient = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authorization } },
    auth: { persistSession: false },
  });
  const { data, error } = await userClient.auth.getUser();
  if (error || !data.user) return json(401, { error: 'invalid_session' });

  const admin = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false } });
  // Hard-delete only after Supabase has verified the caller's bearer token.
  // Database rows referencing auth.users are removed by ON DELETE CASCADE.
  const { error: deleteError } = await admin.auth.admin.deleteUser(data.user.id, false);
  if (deleteError) return json(500, { error: 'account_deletion_failed' });
  return json(200, { ok: true });
});
