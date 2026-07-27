# Hintily phases 5–10 local test guide

No server secret belongs in the desktop `.env`.

## Business decisions implemented

- The free trial is 1,200 seconds, granted once per Google/Supabase account.
- Trial and paid time do not expire and unused seconds survive restarts.
- Trial time may span multiple interviews.
- Each paid pack produces separate 3,600-second allocations.
- One account may have only one open metered session at a time.
- A reservation expires after five minutes if STT never activates.
- Reconnect uses the same client session ID.
- Managed audio passes through an authenticated Supabase WebSocket relay; the
  permanent Deepgram credential and provider tokens never reach the desktop.
- Time is derived from the database clock while at least one relay channel is
  connected. Concurrent system and microphone channels consume one wall-clock session.
- A startup failure releases an allocation when no time was consumed.
- Refunds and adverse disputes revoke only unused allocations belonging to that
  purchase; won or cancelled disputes restore only that purchase's valid access.

## Apply to the existing Supabase project

Run these files in SQL Editor in order:

1. `supabase/migrations/202607270002_hintily_existing_project_compat.sql`
2. `supabase/migrations/202607270003_hintily_business_sessions.sql`
3. `supabase/migrations/202607270004_hintily_dodo_processing.sql`

Deploy these Edge Functions:

```sh
supabase functions deploy hintily-business
supabase functions deploy hintily-checkout
supabase functions deploy hintily-dodo-webhook --no-verify-jwt
supabase functions deploy hintily-deepgram-stream
```

Only the Dodo webhook disables Supabase JWT verification because Dodo authenticates
with a Standard Webhooks signature. The function still rejects unsigned, stale, or
incorrectly signed requests.

## Server secrets

Set these through Supabase Edge Function secrets:

```text
DODO_PAYMENTS_API_KEY
DODO_PAYMENTS_WEBHOOK_KEY
DODO_PAYMENTS_ENVIRONMENT=test_mode
DODO_PRODUCT_MAP
HINTILY_CHECKOUT_RETURN_URL
HINTILY_CHECKOUT_CANCEL_URL
DEEPGRAM_API_KEY
```

`DODO_PRODUCT_MAP` is JSON. Replace every placeholder with the product ID from the
Dodo test-mode dashboard:

```json
{
  "session_1": {"productId":"pdt_REPLACE","sessions":1,"unlimited":false},
  "session_3": {"productId":"pdt_REPLACE","sessions":3,"unlimited":false},
  "session_7": {"productId":"pdt_REPLACE","sessions":7,"unlimited":false},
  "session_12":{"productId":"pdt_REPLACE","sessions":12,"unlimited":false},
  "unlimited_monthly":{"productId":"pdt_REPLACE","sessions":0,"unlimited":true,"interval":"month"},
  "unlimited_quarterly":{"productId":"pdt_REPLACE","sessions":0,"unlimited":true,"interval":"quarter"},
  "unlimited_yearly":{"productId":"pdt_REPLACE","sessions":0,"unlimited":true,"interval":"year"},
  "unlimited_lifetime":{"productId":"pdt_REPLACE","sessions":0,"unlimited":true,"interval":"lifetime"}
}
```

Use the existing Supabase URL and anon key in the desktop `.env`. Google OAuth does
not need to be recreated.

## Dodo dashboard

- Webhook URL: `https://PROJECT_REF.supabase.co/functions/v1/hintily-dodo-webhook`
- Subscribe to payment, subscription, refund, and dispute events.
- Keep checkout in test mode until every case below passes.
- The success redirect is informational only. Access is granted exclusively by a
  verified webhook.

## Local verification checklist

1. Sign in with Google and confirm exactly 20:00 appears.
2. Restart Hintily and confirm the same balance appears.
3. Sign out/in repeatedly and confirm no second trial row is created.
4. Select the existing internal managed-provider option and start a meeting.
5. Confirm both system and microphone transcripts continue to arrive.
6. Confirm time starts decreasing only after Deepgram connects.
7. Disconnect/reconnect the network and confirm the same business session resumes.
8. Stop and restart the meeting and confirm unused seconds remain.
9. Complete a Dodo test purchase and wait for the webhook; do not rely on redirect.
10. Replay the webhook and confirm no duplicate allocations are created.
11. Refund the purchase and confirm only its unused allocations become revoked.
12. Open a dispute, then mark it won/cancelled and confirm only that purchase's
    still-valid access is restored.
13. Upload representative PDF, DOCX, and TXT resumes.
14. Confirm renamed files, files over 10 MB, empty files, corrupt files, encrypted
    PDFs, and scanned PDFs without a text layer are rejected safely.

## Queries useful while debugging

```sql
select * from entitlements order by created_at desc;
select * from purchases order by created_at desc;
select * from session_allocations order by created_at desc;
select * from business_sessions order by created_at desc;
select * from usage_sessions order by created_at desc;
select provider_event_id, event_type, status, error_code, attempts
from webhook_events order by received_at desc;
```
