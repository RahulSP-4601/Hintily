import { corsHeaders } from '../_shared/cors.ts';
import { json } from '../_shared/http.ts';

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  return json(410, {
    error: 'direct_provider_tokens_disabled',
    replacement: 'hintily-deepgram-stream',
  }, corsHeaders);
});
