import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../../..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');

test('phase 11 migration is replay-safe and preserves business records', () => {
  const hardening = read('supabase/migrations/202607280004_hintily_phases_11_to_14.sql');
  const compatibility = read('supabase/migrations/202607270002_hintily_existing_project_compat.sql');
  const singleUse = read('supabase/migrations/202607280001_hintily_single_use_sessions.sql');
  assert.match(compatibility, /if not exists/i);
  assert.doesNotMatch(`${hardening}\n${compatibility}`, /\bdrop\s+(table|column)\b/i);
  for (const field of [
    'session_type', 'maximum_seconds', 'consumed_at', 'forfeited_seconds',
    'reservation_expires_at', 'activation_completed_at', 'completion_reason',
    'last_heartbeat_at', 'starts_at', 'ends_at',
  ]) assert.match(`${compatibility}\n${singleUse}`, new RegExp(field));
  assert.match(hardening, /session_allocations_available_selection_idx/);
  assert.match(hardening, /business_sessions_user_active_idx/);
});

test('customer UI exposes every accurate Hintily account and purchase state', () => {
  const account = read('src/components/settings/HintilyAccountSettings.tsx');
  assert.match(account, /Sign in with Google/);
  assert.match(account, /Sign out/);
  assert.match(account, /Delete account/);
  assert.match(account, /1 free session · \$\{account\.paid_session_count\} paid session/);
  assert.match(account, /paid session/);
  assert.match(account, /unused time does not carry forward/);
  for (const price of ['₹499', '₹1,099', '₹1,899', '₹2,799', '₹3,399', '₹7,497', '₹25,188', '₹35,000']) {
    assert.match(account, new RegExp(price));
  }
  assert.match(account, /Payment is still being verified/);
  assert.match(account, /Purchase history/);
  assert.match(account, /Refunds & support/);
});

test('provider-backed actions have server-side rate limits and private retention', () => {
  const hardening = read('supabase/migrations/202607280004_hintily_phases_11_to_14.sql');
  const checkout = read('supabase/functions/hintily-checkout/index.ts');
  const business = read('supabase/functions/hintily-business/index.ts');
  const deepgram = read('supabase/functions/hintily-deepgram-stream/index.ts');
  assert.match(hardening, /hintily_consume_action_rate/);
  assert.match(hardening, /revoke all on table public\.hintily_action_rate_limits/);
  assert.match(checkout, /consumeActionRate\(auth\.client, 'checkout'/);
  assert.match(business, /consumeActionRate\(auth\.client, 'session_authorize'/);
  assert.match(deepgram, /requested_action: 'deepgram_authorize'/);
  assert.match(hardening, /hintily_cleanup_ephemeral_security_data/);
  assert.doesNotMatch(hardening, /delete from public\.(purchases|entitlements|session_allocations|business_sessions)/);
});

test('Electron denies renderer popups, webviews, and cross-document navigation', () => {
  const main = read('electron/main.ts');
  assert.match(main, /app\.on\('web-contents-created'/);
  assert.match(main, /setWindowOpenHandler\(\(\{ url \}\)/);
  assert.match(main, /target\.protocol === 'https:'[\s\S]*shell\.openExternal/);
  assert.match(main, /return \{ action: 'deny' \}/);
  assert.match(main, /will-attach-webview'[\s\S]*preventDefault/);
  assert.match(main, /will-navigate'[\s\S]*sameRendererDocument[\s\S]*preventDefault/);
});
