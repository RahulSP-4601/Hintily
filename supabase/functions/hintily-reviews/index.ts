import { corsHeaders } from '../_shared/cors.ts';
import {
  authenticatedClient,
  consumeActionRate,
  json,
  readJson,
} from '../_shared/http.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const response = (status: number, body: unknown) => json(status, body, corsHeaders);

type PromptState = {
  has_reviewed?: boolean;
  dismissed_count?: number;
  dont_show_again?: boolean;
  last_prompted_at?: string | null;
  last_dismissed_at?: string | null;
  next_eligible_at?: string | null;
  session_count?: number;
  total_usage_ms?: number;
};

const eligibility = (state: PromptState) => {
  if (state.has_reviewed) return { eligible: false, reason: 'has_reviewed' };
  if (state.dont_show_again) return { eligible: false, reason: 'dont_show_again' };
  const now = Date.now();
  const nextEligible = state.next_eligible_at
    ? new Date(state.next_eligible_at).getTime()
    : 0;
  if (nextEligible > now) {
    return {
      eligible: false,
      reason: 'cooldown',
      next_eligible_at: state.next_eligible_at,
    };
  }
  const sessions = Number(state.session_count) || 0;
  const usageMs = Number(state.total_usage_ms) || 0;
  const dismissals = Number(state.dismissed_count) || 0;
  if (dismissals === 0) {
    return sessions >= 3 || usageMs >= 30 * 60 * 1000
      ? { eligible: true, reason: 'first_time_threshold_met' }
      : { eligible: false, reason: 'first_time_threshold_not_met' };
  }
  const anchor = state.last_dismissed_at || state.last_prompted_at;
  const anchorMs = anchor ? new Date(anchor).getTime() : 0;
  if (!anchorMs || now - anchorMs >= 7 * 24 * 60 * 60 * 1000) {
    return { eligible: true, reason: 'redisplay_delay_met' };
  }
  return sessions >= 3 + dismissals * 3
    ? { eligible: true, reason: 'redisplay_sessions_met' }
    : { eligible: false, reason: 'redisplay_threshold_not_met' };
};

const cleanOptional = (value: unknown, max: number): string | null => {
  if (typeof value !== 'string') return null;
  const cleaned = value.replace(/[<>\u0000-\u001f\u007f]/g, '').trim().slice(0, max);
  return cleaned || null;
};

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  const auth = await authenticatedClient(request);
  if (!auth) return response(401, { error: 'unauthorized' });

  try {
    const segments = new URL(request.url).pathname.split('/').filter(Boolean);
    const functionIndex = segments.lastIndexOf('hintily-reviews');
    const action = functionIndex >= 0 ? segments[functionIndex + 1] : undefined;
    const identifier = functionIndex >= 0 ? segments[functionIndex + 2] : undefined;

    if (action === 'prompt-state' && request.method === 'GET') {
      if (!await consumeActionRate(auth.client, 'review_read', 30, 60)) {
        return response(429, { error: 'rate_limit_exceeded' });
      }
      await auth.client.from('review_prompt_state').upsert(
        { user_id: auth.user.id },
        { onConflict: 'user_id', ignoreDuplicates: true },
      );
      const { data, error } = await auth.client
        .from('review_prompt_state')
        .select('*')
        .eq('user_id', auth.user.id)
        .single();
      if (error || !data) return response(503, { error: 'review_state_unavailable' });
      return response(200, { ok: true, state: data, ...eligibility(data) });
    }

    if (action === 'prompt-state' && request.method === 'POST') {
      if (!await consumeActionRate(auth.client, 'review_event', 30, 60)) {
        return response(429, { error: 'rate_limit_exceeded' });
      }
      const body = await readJson(request);
      const event = body.event && typeof body.event === 'object'
        ? body.event as Record<string, unknown>
        : {};
      const eventType = String(event.type || '');
      const usageMs = eventType === 'session'
        ? Math.min(Math.max(Math.floor(Number(event.usage_ms) || 0), 0), 21_600_000)
        : 0;
      if (!['session', 'dismiss_later', 'dont_show_again', 'shown'].includes(eventType)) {
        return response(400, { error: 'invalid_review_event' });
      }
      const { data, error } = await auth.client.rpc('hintily_review_record_event', {
        requested_event: eventType,
        requested_usage_ms: usageMs,
      });
      if (error || !data) return response(503, { error: 'review_event_failed' });
      return response(200, { ok: true, state: data });
    }

    if (action === 'submit' && request.method === 'POST') {
      if (!await consumeActionRate(auth.client, 'review_submit', 5, 600)) {
        return response(429, { error: 'rate_limit_exceeded' });
      }
      const body = await readJson(request);
      const rating = Number(body.rating);
      if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
        return response(400, { error: 'rating_required_1_to_5' });
      }
      const reviewText = cleanOptional(body.review_text, 300);
      const { data, error } = await auth.client.rpc('hintily_submit_review', {
        requested_rating: rating,
        requested_review_text: reviewText || '',
        requested_app_version: cleanOptional(body.app_version, 40) || '',
        requested_platform: cleanOptional(body.platform, 20) || '',
        requested_build_channel: cleanOptional(body.build_channel, 40) || '',
      });
      if (error || !UUID.test(String(data || ''))) {
        return response(503, { error: 'review_submission_failed' });
      }
      return response(200, { ok: true, id: data });
    }

    if (action === 'testimonial' && request.method === 'PATCH' && UUID.test(identifier || '')) {
      if (!await consumeActionRate(auth.client, 'review_testimonial', 10, 60)) {
        return response(429, { error: 'rate_limit_exceeded' });
      }
      const body = await readJson(request);
      const canUsePublicly = body.can_use_publicly === true;
      const { data, error } = await auth.client
        .from('reviews')
        .update({
          testimonial_name: cleanOptional(body.name, 80),
          testimonial_role: cleanOptional(body.role, 80),
          testimonial_company: cleanOptional(body.company, 80),
          can_use_publicly: canUsePublicly,
          display_name_publicly: canUsePublicly && body.display_name_publicly === true,
          updated_at: new Date().toISOString(),
        })
        .eq('id', identifier)
        .eq('user_id', auth.user.id)
        .select('id')
        .maybeSingle();
      if (error) return response(503, { error: 'testimonial_update_failed' });
      if (!data) return response(404, { error: 'review_not_found' });
      return response(200, { ok: true });
    }

    return response(404, { error: 'not_found' });
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    if (message === 'request_too_large' || message === 'invalid_json') {
      return response(400, { error: message });
    }
    return response(503, { error: 'review_service_unavailable' });
  }
});
