# Hintily Recovery and Environment Rules

## Repository

- This directory is the Hintily Git root.
- `Desktop/hintly-corrupt` is historical evidence and must remain read-only.
- Never copy the corrupt tree over this repository.
- Restore individual, reviewed files only.
- Production changes should be made through migrations and reviewed deployment workflows.

## Environments

Use separate Supabase and Dodo projects for development, staging, and production.

Required desktop-safe values:

- `HINTILY_ENV`
- `HINTILY_SUPABASE_URL`
- `HINTILY_SUPABASE_ANON_KEY`
- `HINTILY_OAUTH_CALLBACK_URL`
- `HINTILY_WEBSITE_URL`
- `HINTILY_SUPPORT_URL`

Server-only secrets must be configured in Supabase Edge Function secrets and must never be packaged:

- `SUPABASE_SERVICE_ROLE_KEY`
- `DODO_API_KEY`
- `DODO_WEBHOOK_SECRET`
- Managed Deepgram and LLM credentials

## Backup checklist

Before each production migration:

1. Create or confirm a Supabase database backup.
2. Export the current schema.
3. Record deployed Edge Function versions.
4. Export Dodo product identifiers and webhook destination metadata.
5. Test the migration on staging.
6. Verify the rollback procedure.

