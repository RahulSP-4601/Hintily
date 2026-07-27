# Hintily End-to-End Rebuild Checklist

This document is the implementation roadmap for rebuilding Hintily from the fresh Natively baseline.

The existing interview-helper and meeting pipelines are protected. Business, authentication, payment, usage, managed STT, and profile-intelligence changes must be introduced at clear boundaries and guarded by regression tests.

## Phase 0 — Recovery and Repository Safety

- [ ] Confirm the canonical product spelling: **Hintily**.
- [ ] Preserve `Desktop/hintly-corrupt` as read-only evidence.
- [ ] Export the existing Supabase database schema.
- [ ] Export deployed Supabase Edge Functions, if recoverable.
- [ ] Export Dodo product and webhook configuration.
- [ ] Back up the saved `.env` securely.
- [ ] Create a redacted `.env.example`.
- [ ] Make `hintily` an independent Git repository.
- [ ] Connect it to a private remote repository.
- [ ] Commit and tag the untouched Natively baseline.
- [ ] Create a dedicated rebuild branch.
- [ ] Configure automatic Supabase backups.
- [ ] Add pre-commit secret detection.
- [ ] Add CI for builds, type checking, and tests.

### Completion gate

- [ ] The fresh baseline can be restored from Git.
- [ ] Secrets are not committed.
- [ ] The corrupt and fresh folders cannot be accidentally mixed.

## Phase 1 — Protect the Natively Core

Before changing business logic, create baseline tests for:

- [ ] Application launch.
- [ ] Launcher window.
- [ ] Interview overlay.
- [ ] Meeting start and stop.
- [ ] Microphone permission.
- [ ] Microphone audio capture.
- [ ] System-audio capture.
- [ ] Transcript delivery to the renderer.
- [ ] Typed-question answer generation.
- [ ] Live-question answer generation.
- [ ] Streaming responses in the overlay.
- [ ] Meeting-history persistence.
- [ ] Resume and JD upload screens.
- [ ] Existing coding-question behavior.
- [ ] Existing meeting-mode behavior.

### Protected areas

Avoid redesigning these during the rebuild:

- [ ] Native microphone capture.
- [ ] System-audio capture.
- [ ] Meeting lifecycle.
- [ ] Interview question detection.
- [ ] Transcript assembly.
- [ ] Answer streaming.
- [ ] Overlay behavior.
- [ ] Meeting persistence.
- [ ] Coding-answer pipeline.
- [ ] Mode routing outside Hintily-specific integration.

### Completion gate

- [ ] The baseline regression suite passes before Hintily changes begin.

## Phase 2 — Central Hintily Configuration

- [ ] Create one typed Hintily configuration module.
- [ ] Define development, staging, and production environments.
- [ ] Standardize environment variables under `HINTILY_*`.
- [ ] Temporarily support old `HINTLY_*` variables as migration aliases.
- [ ] Configure the Supabase URL and public key.
- [ ] Configure the Hintily Edge Function base URL.
- [ ] Configure Dodo product mappings.
- [ ] Configure checkout success and cancellation URLs.
- [ ] Configure the Google OAuth callback URL.
- [ ] Configure Deepgram through server-side secrets.
- [ ] Add startup validation for required configuration.
- [ ] Ensure service-role, Dodo, managed LLM, and Deepgram secrets never reach the renderer.

### Completion gate

- [ ] Missing configuration produces a clear startup error.
- [ ] Development and production cannot accidentally use each other's projects.

## Phase 3 — Controlled Rebranding

### Application identity

- [ ] Change the package name to Hintily.
- [ ] Change product and executable names.
- [ ] Set the macOS bundle ID.
- [ ] Set the Windows application ID.
- [ ] Change installer filenames.
- [ ] Change the application data directory.
- [ ] Define the Hintily deep-link protocol.
- [ ] Replace application icons.
- [ ] Replace logos and splash assets.
- [ ] Update window and process titles.
- [ ] Update the About screen.
- [ ] Update website and support links.

### User-facing language

- [ ] Replace visible Natively branding.
- [ ] Rename “Natively API” to “Hintily AI.”
- [ ] Remove Natively checkout URLs.
- [ ] Remove Natively licensing language.
- [ ] Replace Natively pricing screens.
- [ ] Replace Natively trial advertisements.
- [ ] Update onboarding.
- [ ] Update help documentation.
- [ ] Update privacy, terms, and refund documents.
- [ ] Regenerate translations after English text stabilizes.

### Internal migration

- [ ] Keep compatibility wrappers around old internal names initially.
- [ ] Avoid global search-and-replace.
- [ ] Rename internal services gradually with tests.
- [ ] Migrate the old data directory safely if needed.

### Completion gate

- [ ] No user-facing Natively branding remains.
- [ ] Existing interview and meeting tests still pass.

## Phase 4 — Supabase Foundation and Google OAuth

### Authentication

- [ ] Enable Google OAuth in Supabase.
- [ ] Configure authorized redirect URLs.
- [ ] Implement PKCE/deep-link OAuth for Electron.
- [ ] Store sessions securely in the main process.
- [ ] Refresh expired access tokens.
- [ ] Restore sessions on startup.
- [ ] Implement logout.
- [ ] Implement account deletion.
- [ ] Handle revoked Google access.
- [ ] Prevent authentication tokens from entering logs.

### Required tables

- [ ] `user_profiles`
- [ ] `entitlements`
- [ ] `purchases`
- [ ] `session_allocations`
- [ ] `usage_sessions`
- [ ] `business_sessions`
- [ ] `webhook_events`
- [ ] `review_prompt_state`
- [ ] `reviews`

### Database rules

- [ ] Add primary and foreign keys.
- [ ] Add unique constraints.
- [ ] Add status constraints.
- [ ] Add created and updated timestamps.
- [ ] Add indexes for user and entitlement lookups.
- [ ] Enable row-level security.
- [ ] Write policies for every client-visible table.
- [ ] Restrict financial writes to service-role functions.
- [ ] Add immutable purchase and usage audit records.
- [ ] Create repeatable migrations.
- [ ] Test migrations on a clean local database.

### Completion gate

- [ ] A Google user can sign in, restart the app, and remain signed in.
- [ ] A user can read only their own business data.
- [ ] The desktop application cannot grant itself credits.

## Phase 5 — Free 20-Minute Entitlement

### Business rules

- [ ] Represent duration internally in seconds.
- [ ] Set the free-trial allocation to `1,200` seconds.
- [ ] Grant the trial only once per eligible user.
- [ ] Decide device-abuse prevention rules.
- [ ] Decide whether trial time expires.
- [ ] Decide whether trial time can span multiple interviews.
- [ ] Define what activity counts as consumed time.
- [ ] Define behavior when the application or provider fails.

### Implementation

- [ ] Create the free-trial entitlement.
- [ ] Create the initial session allocation.
- [ ] Make trial creation idempotent.
- [ ] Return remaining seconds to the desktop.
- [ ] Display remaining time.
- [ ] Warn at configurable thresholds.
- [ ] Stop managed service access at zero.
- [ ] Preserve the correct remaining time after restart.
- [ ] Prevent negative balances.

### Tests

- [ ] A new user receives exactly 1,200 seconds.
- [ ] Repeat login does not create another trial.
- [ ] Concurrent requests do not duplicate the trial.
- [ ] Failed session startup consumes nothing.
- [ ] Restart preserves the balance.

### Completion gate

- [ ] A new Google user can receive and view one free 20-minute allocation.

## Phase 6 — Paid Session Model

### Business rules

- [ ] One paid session equals `3,600` seconds.
- [ ] Confirm whether packs use separate allocations or one pooled balance.
- [ ] Confirm whether unused session time survives.
- [ ] Confirm whether starting a new interview consumes a new allocation.
- [ ] Define maximum session duration.
- [ ] Define session expiration.
- [ ] Define concurrent-device behavior.
- [ ] Define the reconnection grace period.
- [ ] Define support and refund rules for technical failures.

### Allocation states

- [ ] `available`
- [ ] `reserved`
- [ ] `active`
- [ ] `consumed`
- [ ] `expired`
- [ ] `revoked`

### Session lifecycle

- [ ] Authorize the session.
- [ ] Reserve an allocation atomically.
- [ ] Start the interview.
- [ ] Start charging only after STT becomes active.
- [ ] Send periodic heartbeats.
- [ ] Accumulate consumed seconds.
- [ ] Handle pause and reconnect.
- [ ] Complete the session.
- [ ] Expire abandoned reservations.
- [ ] Restore allocation after a qualifying startup failure.
- [ ] Prevent double consumption.

### Tests

- [ ] A one-session purchase grants 3,600 seconds.
- [ ] Multi-session purchases grant the intended total.
- [ ] Concurrent start requests cannot spend the same allocation.
- [ ] Reconnect resumes the same business session.
- [ ] Usage never exceeds the allocation.
- [ ] An unlimited entitlement bypasses session allocation.

### Completion gate

- [ ] Session time is authorized and accounted for entirely on the server.

## Phase 7 — Dodo Payments

### Product mapping

- [ ] Verify the 1-session product.
- [ ] Verify the 3-session product.
- [ ] Verify the 7-session product.
- [ ] Verify the 12-session product.
- [ ] Verify unlimited monthly.
- [ ] Verify unlimited quarterly.
- [ ] Verify unlimited yearly.
- [ ] Verify unlimited lifetime.
- [ ] Store product mappings server-side.
- [ ] Confirm price, currency, tax, and billing interval.

### Checkout

- [ ] Have the backend create or resolve checkout.
- [ ] Associate checkout with the authenticated user.
- [ ] Open Dodo checkout externally.
- [ ] Configure the success URL.
- [ ] Configure the cancellation URL.
- [ ] Return to Hintily through a deep link.
- [ ] Refresh entitlements after checkout.
- [ ] Show a pending-payment state.

### Webhooks

- [ ] Implement the Dodo webhook Edge Function.
- [ ] Verify webhook signatures.
- [ ] Store unique webhook event IDs.
- [ ] Make processing idempotent.
- [ ] Match the Dodo customer to the Supabase user.
- [ ] Record purchases.
- [ ] Grant session allocations.
- [ ] Activate unlimited plans.
- [ ] Process renewals.
- [ ] Process cancellations.
- [ ] Process expirations.
- [ ] Process failed payments.
- [ ] Process refunds.
- [ ] Process disputes and chargebacks.
- [ ] Log sanitized processing failures.
- [ ] Support safe webhook replay.

### Tests

- [ ] A duplicate event does not grant duplicate sessions.
- [ ] An unknown product does not grant access.
- [ ] An invalid signature is rejected.
- [ ] A refund revokes only the correct unused entitlement.
- [ ] A renewal extends the correct subscription.
- [ ] A checkout redirect alone cannot grant access.

### Completion gate

- [ ] A test purchase produces the correct Supabase entitlement automatically.

## Phase 8 — Hintily Business Service in Electron

- [ ] Recreate a typed `HintilyBusinessService`.
- [ ] Keep it in the Electron main process.
- [ ] Add secure Supabase authentication methods.
- [ ] Add account-state methods.
- [ ] Add entitlement retrieval.
- [ ] Add remaining-time retrieval.
- [ ] Add session authorization.
- [ ] Add session heartbeat.
- [ ] Add session completion.
- [ ] Add checkout initiation.
- [ ] Add post-checkout refresh.
- [ ] Add retry and timeout handling.
- [ ] Add offline-state handling.
- [ ] Add privacy-safe diagnostics.
- [ ] Expose only narrow IPC methods.
- [ ] Validate every renderer-provided IPC input.

### Renderer states

- [ ] Signed out.
- [ ] Loading.
- [ ] Free trial.
- [ ] Paid sessions.
- [ ] Unlimited.
- [ ] Exhausted.
- [ ] Payment pending.
- [ ] Offline or unverified.
- [ ] Active session.

### Completion gate

- [ ] The renderer cannot access service credentials or alter entitlement state directly.

## Phase 9 — Managed Deepgram STT

### Integration boundary

Preserve:

- Existing microphone capture.
- Existing system-audio capture.
- Existing meeting lifecycle.
- Existing transcript event flow.

Replace only:

- Provider authorization.
- Managed Deepgram connection.
- Usage and session enforcement.

### Implementation

- [ ] Keep permanent Deepgram credentials server-side.
- [ ] Require a valid Hintily business session.
- [ ] Create short-lived transcription authorization.
- [ ] Establish Deepgram streaming.
- [ ] Preserve the system/interviewer channel.
- [ ] Preserve the microphone/user channel.
- [ ] Send language and accent configuration.
- [ ] Handle partial transcripts.
- [ ] Process final transcripts.
- [ ] Handle reconnects.
- [ ] Resume the same business session after reconnect.
- [ ] Report active usage seconds.
- [ ] Close transcription at zero balance.
- [ ] Close provider sockets when the interview stops.
- [ ] Map provider errors to understandable UI errors.
- [ ] Prevent transcript content from entering routine logs.

### Accuracy validation

- [ ] Test multiple accents.
- [ ] Test quiet and noisy rooms.
- [ ] Test fast interview speech.
- [ ] Test technical terminology.
- [ ] Test partial-to-final replacement.
- [ ] Test question punctuation and boundaries.
- [ ] Test follow-up questions and pronouns.
- [ ] Compare live transcripts against reference transcripts.

### Completion gate

- [ ] A valid user can receive reliable final transcripts without exposing the managed Deepgram key.

## Phase 10 — Resume Document Extraction

### Supported documents

- [ ] PDF.
- [ ] DOCX.
- [ ] TXT.
- [ ] Decide whether to support scanned PDFs and OCR.

### Safety

- [ ] Validate file extension.
- [ ] Validate MIME type or file signature.
- [ ] Enforce a file-size limit.
- [ ] Reject unsupported formats.
- [ ] Reject empty documents.
- [ ] Handle corrupt documents.
- [ ] Handle password-protected PDFs.
- [ ] Restrict file selection to approved paths.
- [ ] Clean temporary files.
- [ ] Avoid logging document content.

### Extraction

- [ ] Extract text.
- [ ] Preserve page metadata.
- [ ] Normalize whitespace.
- [ ] Preserve useful section boundaries.
- [ ] Calculate a document hash.
- [ ] Detect degenerate extraction.
- [ ] Display a safe extraction preview.
- [ ] Test one-column and two-column resumes.

### Completion gate

- [ ] Representative resumes produce readable and complete extracted text.

## Phase 11 — Structured Resume Parser

### Versioned schema

- [ ] Identity.
- [ ] Contact information.
- [ ] Summary.
- [ ] Work experience.
- [ ] Projects.
- [ ] Education.
- [ ] Skills by category.
- [ ] Achievements.
- [ ] Certifications.
- [ ] Languages.
- [ ] Source evidence.
- [ ] Extraction metadata.

### Parsing pipeline

- [ ] Run heuristic parsing.
- [ ] Run structured model extraction.
- [ ] Validate output against the schema.
- [ ] Normalize dates and technologies.
- [ ] Preserve source text for every claim.
- [ ] Detect degenerate model output.
- [ ] Fall back to heuristic results when necessary.
- [ ] Avoid inventing missing facts.
- [ ] Mark uncertain fields.
- [ ] Version parser output.

### User control

- [ ] Show the parsed profile.
- [ ] Allow field corrections.
- [ ] Allow removal of incorrect fields.
- [ ] Save approved changes.
- [ ] Replace the old resume atomically on re-upload.
- [ ] Remove derived profile data when a resume is deleted.
- [ ] Prevent parser upgrades from silently overwriting user corrections.

### Evaluation

- [ ] Build at least 20 anonymized resume fixtures.
- [ ] Measure field-level accuracy.
- [ ] Measure experience and project separation.
- [ ] Measure skills extraction.
- [ ] Measure source-evidence fidelity.
- [ ] Test sparse and nontechnical resumes.
- [ ] Test unusual formatting.

### Completion gate

- [ ] The parsed profile is accurate enough for user approval before interview use.

## Phase 12 — Job Description Parser

- [ ] Extract company.
- [ ] Extract role title.
- [ ] Extract seniority.
- [ ] Extract employment type.
- [ ] Extract responsibilities.
- [ ] Extract required skills.
- [ ] Extract preferred skills.
- [ ] Extract years-of-experience requirements.
- [ ] Extract technologies.
- [ ] Extract education requirements.
- [ ] Extract location and remote requirements.
- [ ] Extract compensation only when explicitly present.
- [ ] Preserve source evidence.
- [ ] Mark missing information honestly.
- [ ] Allow review and correction.
- [ ] Replace an old JD atomically.
- [ ] Invalidate dependent cached answers after replacement.

### Completion gate

- [ ] JD-only questions can be answered from structured, source-backed evidence.

## Phase 13 — Profile and JD Persistence

- [ ] Store original documents locally or according to the chosen privacy policy.
- [ ] Store structured profile data.
- [ ] Store structured JD data.
- [ ] Store source spans.
- [ ] Define the active resume.
- [ ] Define the active JD.
- [ ] Load active documents on startup.
- [ ] Maintain user separation.
- [ ] Delete derived nodes transactionally.
- [ ] Clear stale in-memory caches after replacement or deletion.
- [ ] Rebuild retrieval indexes when documents change.
- [ ] Decide whether profile data remains local-only or is synchronized.
- [ ] Encrypt sensitive local data where appropriate.

### Completion gate

- [ ] Restarting the application restores the correct active resume and JD.

## Phase 14 — Question Routing

- [ ] Identity questions use resume only.
- [ ] Experience questions use resume only.
- [ ] Project questions use resume only.
- [ ] Education questions use resume only.
- [ ] JD-summary questions use JD only.
- [ ] JD-requirement questions use JD only.
- [ ] Role-fit questions use resume and JD.
- [ ] Gap-analysis questions use resume and JD.
- [ ] Role-specific introductions use resume and JD.
- [ ] General introductions use resume only.
- [ ] Negotiation questions use only permitted compensation context.
- [ ] Coding questions use neither resume nor JD.
- [ ] General technical questions use neither unless explicitly requested.
- [ ] Meeting questions use meeting and transcript context.
- [ ] Reference-file modes respect their source boundaries.
- [ ] Follow-ups preserve the correct previous subject.

### Regression suite

- [ ] Preserve the existing 26 routing scenarios.
- [ ] Add live-transcript variants.
- [ ] Add STT-misspelled variants.
- [ ] Add ambiguous pronouns.
- [ ] Add rapid topic switching.
- [ ] Add multipart questions.
- [ ] Add coding questions during interview mode.
- [ ] Add meeting questions with a loaded resume.

### Completion gate

- [ ] Every route receives only its permitted context layers.

## Phase 15 — Evidence Selection and Prompt Construction

- [ ] Select evidence based on the route.
- [ ] Tag resume evidence as `profile_resume`.
- [ ] Tag JD evidence as `profile_jd`.
- [ ] Tag live transcript evidence separately.
- [ ] Preserve trust level and source.
- [ ] Include only relevant evidence.
- [ ] Keep source blocks clearly separated.
- [ ] Place system instructions before untrusted documents.
- [ ] Treat uploaded documents as evidence, not instructions.
- [ ] Represent missing evidence explicitly.
- [ ] Prevent salary or private context from leaking into unrelated answers.
- [ ] Record evidence diagnostics without recording raw content.

### Critical verification

For every answer, prove:

- [ ] The intended route was selected.
- [ ] The intended evidence was retrieved.
- [ ] Evidence reached the final prompt.
- [ ] The final answer used only allowed evidence.
- [ ] Unsupported claims were rejected or qualified.

### Completion gate

- [ ] The resume/JD evidence verifier passes end to end.

## Phase 16 — Remove Inaccurate-Answer Pathways

### Cached and AOT answer control

- [ ] Find every cached or precomputed final-answer path.
- [ ] Prevent stale introductions from bypassing fresh validation.
- [ ] Invalidate cached answers after resume or JD changes.
- [ ] Require current source-version IDs.
- [ ] Permit caching retrieval artifacts, not unchecked final answers.
- [ ] Run final-answer policy at actual emit sites.

### Previous-answer contamination

- [ ] Label prior assistant suggestions separately.
- [ ] Never treat prior suggestions as factual evidence.
- [ ] Strip prior suggestions where they can contaminate grounding.
- [ ] Preserve user and interviewer transcript context.
- [ ] Keep conversational continuity without recycling unsupported claims.
- [ ] Reset answer memory when the resume or JD changes.
- [ ] Test topic switching.

### Completion gate

- [ ] Repeated questions do not inherit unrelated facts from previous AI suggestions.

## Phase 17 — Final Answer Generation and Validation

- [ ] Generate natural spoken answers.
- [ ] Use first person for candidate responses.
- [ ] Use STAR structure when appropriate.
- [ ] Keep answers concise enough for live interviews.
- [ ] Avoid robotic résumé recitation.
- [ ] Do not invent employers, dates, metrics, tools, or achievements.
- [ ] Admit when evidence is insufficient.
- [ ] Distinguish required from preferred JD qualifications.
- [ ] Avoid claiming unmet requirements.
- [ ] Stream validated output to the overlay.
- [ ] Detect provider errors and leaked JSON envelopes.
- [ ] Validate named entities and numerical claims.
- [ ] Validate output against selected evidence.
- [ ] Fall back safely if validation fails.

### Completion gate

- [ ] Every factual candidate claim is supported by approved resume or JD evidence.

## Phase 18 — Live Interview Integration

The complete path is:

```text
Google login
→ entitlement check
→ reserve time
→ existing voice capture
→ managed Deepgram
→ final transcript
→ question extraction
→ route selection
→ evidence retrieval
→ answer generation
→ evidence validation
→ overlay streaming
→ usage heartbeat
→ session completion
```

- [ ] Starting an interview requires authorization.
- [ ] Provider startup succeeds before charging.
- [ ] Partial transcripts do not create duplicate answers.
- [ ] Final transcripts replace partial text.
- [ ] Duplicate questions are deduplicated.
- [ ] Follow-up questions retain relevant context.
- [ ] Old suggestions do not contaminate new answers.
- [ ] Reconnect uses the same business session.
- [ ] Stopping closes audio and provider connections.
- [ ] Final consumed seconds are reconciled.
- [ ] Remaining balance refreshes.
- [ ] Meeting mode remains unaffected.

### Completion gate

- [ ] A live spoken question produces the same grounded result as its typed equivalent.

## Phase 19 — Business UI

- [ ] Sign-in screen.
- [ ] Google login button.
- [ ] Account profile.
- [ ] Free-trial explanation.
- [ ] Remaining-time display.
- [ ] Low-time warning.
- [ ] Out-of-time state.
- [ ] Session-pack pricing.
- [ ] Unlimited pricing.
- [ ] Checkout progress.
- [ ] Purchase-success state.
- [ ] Payment-pending state.
- [ ] Purchase history.
- [ ] Subscription state.
- [ ] Customer portal.
- [ ] Refund and support links.
- [ ] Logout.
- [ ] Account deletion.
- [ ] Privacy controls.
- [ ] Resume and JD deletion.

### Completion gate

- [ ] Every entitlement state has a clear and accurate UI.

## Phase 20 — Privacy, Security, and Abuse Prevention

- [ ] Keep the Supabase service-role key server-side.
- [ ] Keep the Dodo API key server-side.
- [ ] Keep the Dodo webhook secret server-side.
- [ ] Keep the permanent Deepgram key server-side.
- [ ] Keep managed LLM keys server-side.
- [ ] Validate every Edge Function JWT.
- [ ] Verify webhook signatures.
- [ ] Rate-limit authentication and session creation.
- [ ] Prevent credit replay.
- [ ] Prevent concurrent double spending.
- [ ] Redact resumes, JDs, transcripts, prompts, and tokens from logs.
- [ ] Encrypt sensitive credentials.
- [ ] Define data-retention periods.
- [ ] Implement data export and deletion.
- [ ] Add account and device abuse monitoring.
- [ ] Add dependency and secret scans.
- [ ] Review Electron IPC exposure.
- [ ] Review navigation and external-link handling.

### Completion gate

- [ ] A security review finds no client-controlled entitlement or provider-secret path.

## Phase 21 — Testing Matrix

### Unit tests

- [ ] Duration accounting.
- [ ] Entitlement decisions.
- [ ] Product mapping.
- [ ] Resume parsing.
- [ ] JD parsing.
- [ ] Question classification.
- [ ] Evidence selection.
- [ ] Answer validation.
- [ ] STT error mapping.

### Integration tests

- [ ] Google OAuth.
- [ ] Trial allocation.
- [ ] Dodo webhook.
- [ ] Purchase allocation.
- [ ] Refund and cancellation.
- [ ] Deepgram session.
- [ ] Resume upload.
- [ ] JD upload.
- [ ] Prompt evidence.
- [ ] Usage reconciliation.

### End-to-end tests

- [ ] A free user completes an interview.
- [ ] A paid-session user completes an interview.
- [ ] An unlimited user completes an interview.
- [ ] An expired user is blocked appropriately.
- [ ] Reconnection does not double-charge.
- [ ] A purchase unlocks access.
- [ ] Resume or JD replacement invalidates stale context.
- [ ] The meeting workflow remains unchanged.
- [ ] The coding workflow remains unchanged.

### Platforms

- [ ] macOS Apple Silicon.
- [ ] macOS Intel, if supported.
- [ ] Windows 10.
- [ ] Windows 11.
- [ ] Packaged production build.
- [ ] Clean-machine installation.
- [ ] Upgrade from an older Hintily build.

## Phase 22 — Release Readiness

- [ ] Finalize the privacy policy.
- [ ] Finalize the terms.
- [ ] Finalize the refund policy.
- [ ] Finalize the acceptable-use policy.
- [ ] Confirm commercial licensing rights.
- [ ] Configure production Supabase.
- [ ] Configure production Dodo.
- [ ] Configure production Google OAuth.
- [ ] Configure production Deepgram.
- [ ] Configure monitoring and alerts.
- [ ] Configure database backups.
- [ ] Configure crash reporting with redaction.
- [ ] Sign the macOS application.
- [ ] Notarize the macOS application.
- [ ] Sign the Windows installer.
- [ ] Configure application updates.
- [ ] Test rollback.
- [ ] Prepare support procedures.
- [ ] Run the complete release gate.

## Recommended Implementation Order

1. Repository protection and baseline tests.
2. Supabase and Google OAuth.
3. Free 20-minute entitlement.
4. Paid 60-minute session accounting.
5. Dodo Payments.
6. Hintily Electron business service.
7. Managed Deepgram integration.
8. Resume and JD extraction.
9. Structured parsers and persistence.
10. Routing and evidence selection.
11. Accuracy fixes and contamination removal.
12. Live interview end-to-end integration.
13. Remaining rebrand and business UI.
14. Security, packaging, and release.

## Governing Implementation Rule

Preserve the existing meeting and interview engine. Add Hintily business controls at clear boundaries, and require a regression test before modifying any shared intelligence, audio, transcript, overlay, or meeting path.
