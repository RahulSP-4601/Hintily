# Hintily End-to-End Rebuild Checklist

This document is the implementation roadmap for rebuilding Hintily from the fresh Natively baseline.

The existing interview-helper and meeting pipelines are protected. Business, authentication, payment, usage, managed STT, and profile-intelligence changes must be introduced at clear boundaries and guarded by regression tests.

## Current Implementation Status

The application implementation roadmap is complete through Phase 20. The
remaining work is the full release testing matrix and production release
readiness. Detailed checklists below remain as acceptance criteria for manual,
provider, platform, and production verification.

- [x] Phase 0 — Recovery and Repository Safety
- [x] Phase 1 — Protect the Natively Core
- [x] Phase 2 — Central Hintily Configuration
- [x] Phase 3 — Controlled Rebranding
- [x] Phase 4 — Supabase Foundation and Google OAuth
- [x] Phase 5 — Free 20-Minute Entitlement
- [x] Phase 6 — Paid Session Model
- [x] Phase 7 — Dodo Payments
- [x] Phase 8 — Hintily Business Service in Electron
- [x] Phase 9 — Managed Deepgram STT
- [x] Phase 10 — Resume Document Extraction
- [x] Phase 11 — Structured Resume Parser
- [x] Phase 12 — Job Description Parser
- [x] Phase 13 — Profile and JD Persistence
- [x] Phase 14 — Question Routing
- [x] Phase 15 — Evidence Selection and Prompt Construction
- [x] Phase 16 — Remove Inaccurate-Answer Pathways
- [x] Phase 17 — Final Answer Generation and Validation
- [x] Phase 18 — Live Interview Integration
- [x] Phase 19 — Business UI
- [x] Phase 20 — Privacy, Security, and Abuse Prevention
- [ ] Phase 21 — Testing Matrix
- [ ] Phase 22 — Release Readiness

## Phase 0 — Recovery and Repository Safety

- [x] Confirm the canonical product spelling: **Hintily**.
- [x] Preserve `Desktop/hintly-corrupt` as read-only evidence.
- [x] Export the existing Supabase database schema.
- [x] Export deployed Supabase Edge Functions, if recoverable.
- [x] Export Dodo product and webhook configuration.
- [x] Back up the saved `.env` securely.
- [x] Create a redacted `.env.example`.
- [x] Make `hintily` an independent Git repository.
- [x] Connect it to a private remote repository.
- [x] Commit and tag the untouched Natively baseline.
- [x] Create a dedicated rebuild branch.
- [x] Configure automatic Supabase backups.
- [x] Add pre-commit secret detection.
- [x] Add CI for builds, type checking, and tests.

### Completion gate

- [x] The fresh baseline can be restored from Git.
- [x] Secrets are not committed.
- [x] The corrupt and fresh folders cannot be accidentally mixed.

## Phase 1 — Protect the Natively Core

Before changing business logic, create baseline tests for:

- [x] Application launch.
- [x] Launcher window.
- [x] Interview overlay.
- [x] Meeting start and stop.
- [x] Microphone permission.
- [x] Microphone audio capture.
- [x] System-audio capture.
- [x] Transcript delivery to the renderer.
- [x] Typed-question answer generation.
- [x] Live-question answer generation.
- [x] Streaming responses in the overlay.
- [x] Meeting-history persistence.
- [x] Resume and JD upload screens.
- [x] Existing coding-question behavior.
- [x] Existing meeting-mode behavior.

### Protected areas

Avoid redesigning these during the rebuild:

- [x] Native microphone capture.
- [x] System-audio capture.
- [x] Meeting lifecycle.
- [x] Interview question detection.
- [x] Transcript assembly.
- [x] Answer streaming.
- [x] Overlay behavior.
- [x] Meeting persistence.
- [x] Coding-answer pipeline.
- [x] Mode routing outside Hintily-specific integration.

### Completion gate

- [x] The baseline regression suite passes before Hintily changes begin.

## Phase 2 — Central Hintily Configuration

- [x] Create one typed Hintily configuration module.
- [x] Define development, staging, and production environments.
- [x] Standardize environment variables under `HINTILY_*`.
- [x] Temporarily support old `HINTLY_*` variables as migration aliases.
- [x] Configure the Supabase URL and public key.
- [x] Configure the Hintily Edge Function base URL.
- [x] Configure Dodo product mappings.
- [x] Configure checkout success and cancellation URLs.
- [x] Configure the Google OAuth callback URL.
- [x] Configure Deepgram through server-side secrets.
- [x] Add startup validation for required configuration.
- [x] Ensure service-role, Dodo, managed LLM, and Deepgram secrets never reach the renderer.

### Completion gate

- [x] Missing configuration produces a clear startup error.
- [x] Development and production cannot accidentally use each other's projects.

## Phase 3 — Controlled Rebranding

### Application identity

- [x] Change the package name to Hintily.
- [x] Change product and executable names.
- [x] Set the macOS bundle ID.
- [x] Set the Windows application ID.
- [x] Change installer filenames.
- [x] Change the application data directory.
- [x] Define the Hintily deep-link protocol.
- [x] Replace application icons.
- [x] Replace logos and splash assets.
- [x] Update window and process titles.
- [x] Update the About screen.
- [x] Update website and support links.

### User-facing language

- [x] Replace visible Natively branding.
- [x] Rename “Natively API” to “Hintily AI.”
- [x] Remove Natively checkout URLs.
- [x] Remove Natively licensing language.
- [x] Replace Natively pricing screens.
- [x] Replace Natively trial advertisements.
- [x] Update onboarding.
- [x] Update help documentation.
- [x] Update privacy, terms, and refund documents.
- [x] Regenerate translations after English text stabilizes.

### Internal migration

- [x] Keep compatibility wrappers around old internal names initially.
- [x] Avoid global search-and-replace.
- [x] Rename internal services gradually with tests.
- [x] Migrate the old data directory safely if needed.

### Completion gate

- [x] No user-facing Natively branding remains.
- [x] Existing interview and meeting tests still pass.

## Phase 4 — Supabase Foundation and Google OAuth

### Authentication

- [x] Enable Google OAuth in Supabase.
- [x] Configure authorized redirect URLs.
- [x] Implement PKCE/deep-link OAuth for Electron.
- [x] Store sessions securely in the main process.
- [x] Refresh expired access tokens.
- [x] Restore sessions on startup.
- [x] Implement logout.
- [x] Implement account deletion.
- [x] Handle revoked Google access.
- [x] Prevent authentication tokens from entering logs.

### Required tables

- [x] `user_profiles`
- [x] `entitlements`
- [x] `purchases`
- [x] `session_allocations`
- [x] `usage_sessions`
- [x] `business_sessions`
- [x] `webhook_events`
- [x] `review_prompt_state`
- [x] `reviews`

### Database rules

- [x] Add primary and foreign keys.
- [x] Add unique constraints.
- [x] Add status constraints.
- [x] Add created and updated timestamps.
- [x] Add indexes for user and entitlement lookups.
- [x] Enable row-level security.
- [x] Write policies for every client-visible table.
- [x] Restrict financial writes to service-role functions.
- [x] Add immutable purchase and usage audit records.
- [x] Create repeatable migrations.
- [x] Test migrations on a clean local database.

### Completion gate

- [x] A Google user can sign in, restart the app, and remain signed in.
- [x] A user can read only their own business data.
- [x] The desktop application cannot grant itself credits.

## Phase 5 — Free 20-Minute Entitlement

### Business rules

- [x] Represent duration internally in seconds.
- [x] Set the free-trial allocation to `1,200` seconds.
- [x] Grant the trial only once per eligible user.
- [x] Decide device-abuse prevention rules.
- [x] Decide whether trial time expires.
- [x] Decide whether trial time can span multiple interviews.
- [x] Define what activity counts as consumed time.
- [x] Define behavior when the application or provider fails.

### Implementation

- [x] Create the free-trial entitlement.
- [x] Create the initial session allocation.
- [x] Make trial creation idempotent.
- [x] Return remaining seconds to the desktop.
- [x] Display remaining time.
- [x] Warn at configurable thresholds.
- [x] Stop managed service access at zero.
- [x] Preserve the correct remaining time after restart.
- [x] Prevent negative balances.

### Tests

- [x] A new user receives exactly 1,200 seconds.
- [x] Repeat login does not create another trial.
- [x] Concurrent requests do not duplicate the trial.
- [x] Failed session startup consumes nothing.
- [x] Restart preserves the balance.

### Completion gate

- [x] A new Google user can receive and view one free 20-minute allocation.

## Phase 6 — Paid Session Model

### Business rules

- [x] One paid session equals `3,600` seconds.
- [x] Confirm whether packs use separate allocations or one pooled balance.
- [x] Confirm whether unused session time survives.
- [x] Confirm whether starting a new interview consumes a new allocation.
- [x] Define maximum session duration.
- [x] Define session expiration.
- [x] Define concurrent-device behavior.
- [x] Define the reconnection grace period.
- [x] Define support and refund rules for technical failures.

### Allocation states

- [x] `available`
- [x] `reserved`
- [x] `active`
- [x] `consumed`
- [x] `expired`
- [x] `revoked`

### Session lifecycle

- [x] Authorize the session.
- [x] Reserve an allocation atomically.
- [x] Start the interview.
- [x] Start charging only after STT becomes active.
- [x] Send periodic heartbeats.
- [x] Accumulate consumed seconds.
- [x] Handle pause and reconnect.
- [x] Complete the session.
- [x] Expire abandoned reservations.
- [x] Restore allocation after a qualifying startup failure.
- [x] Prevent double consumption.

### Tests

- [x] A one-session purchase grants 3,600 seconds.
- [x] Multi-session purchases grant the intended total.
- [x] Concurrent start requests cannot spend the same allocation.
- [x] Reconnect resumes the same business session.
- [x] Usage never exceeds the allocation.
- [x] An unlimited entitlement bypasses session allocation.

### Completion gate

- [x] Session time is authorized and accounted for entirely on the server.

## Phase 7 — Dodo Payments

### Product mapping

- [x] Verify the 1-session product.
- [x] Verify the 3-session product.
- [x] Verify the 7-session product.
- [x] Verify the 12-session product.
- [x] Verify unlimited monthly.
- [x] Verify unlimited quarterly.
- [x] Verify unlimited yearly.
- [x] Verify unlimited lifetime.
- [x] Store product mappings server-side.
- [x] Confirm price, currency, tax, and billing interval.

### Checkout

- [x] Have the backend create or resolve checkout.
- [x] Associate checkout with the authenticated user.
- [x] Open Dodo checkout externally.
- [x] Configure the success URL.
- [x] Configure the cancellation URL.
- [x] Return to Hintily through a deep link.
- [x] Refresh entitlements after checkout.
- [x] Show a pending-payment state.

### Webhooks

- [x] Implement the Dodo webhook Edge Function.
- [x] Verify webhook signatures.
- [x] Store unique webhook event IDs.
- [x] Make processing idempotent.
- [x] Match the Dodo customer to the Supabase user.
- [x] Record purchases.
- [x] Grant session allocations.
- [x] Activate unlimited plans.
- [x] Process renewals.
- [x] Process cancellations.
- [x] Process expirations.
- [x] Process failed payments.
- [x] Process refunds.
- [x] Process disputes and chargebacks.
- [x] Log sanitized processing failures.
- [x] Support safe webhook replay.

### Tests

- [x] A duplicate event does not grant duplicate sessions.
- [x] An unknown product does not grant access.
- [x] An invalid signature is rejected.
- [x] A refund revokes only the correct unused entitlement.
- [x] A renewal extends the correct subscription.
- [x] A checkout redirect alone cannot grant access.

### Completion gate

- [x] A test purchase produces the correct Supabase entitlement automatically.

## Phase 8 — Hintily Business Service in Electron

- [x] Recreate a typed `HintilyBusinessService`.
- [x] Keep it in the Electron main process.
- [x] Add secure Supabase authentication methods.
- [x] Add account-state methods.
- [x] Add entitlement retrieval.
- [x] Add remaining-time retrieval.
- [x] Add session authorization.
- [x] Add session heartbeat.
- [x] Add session completion.
- [x] Add checkout initiation.
- [x] Add post-checkout refresh.
- [x] Add retry and timeout handling.
- [x] Add offline-state handling.
- [x] Add privacy-safe diagnostics.
- [x] Expose only narrow IPC methods.
- [x] Validate every renderer-provided IPC input.

### Renderer states

- [x] Signed out.
- [x] Loading.
- [x] Free trial.
- [x] Paid sessions.
- [x] Unlimited.
- [x] Exhausted.
- [x] Payment pending.
- [x] Offline or unverified.
- [x] Active session.

### Completion gate

- [x] The renderer cannot access service credentials or alter entitlement state directly.

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

- [x] Keep permanent Deepgram credentials server-side.
- [x] Require a valid Hintily business session.
- [x] Create short-lived transcription authorization.
- [x] Establish Deepgram streaming.
- [x] Preserve the system/interviewer channel.
- [x] Preserve the microphone/user channel.
- [x] Send language and accent configuration.
- [x] Handle partial transcripts.
- [x] Process final transcripts.
- [x] Handle reconnects.
- [x] Resume the same business session after reconnect.
- [x] Report active usage seconds.
- [x] Close transcription at zero balance.
- [x] Close provider sockets when the interview stops.
- [x] Map provider errors to understandable UI errors.
- [x] Prevent transcript content from entering routine logs.

### Accuracy validation

- [x] Test multiple accents.
- [x] Test quiet and noisy rooms.
- [x] Test fast interview speech.
- [x] Test technical terminology.
- [x] Test partial-to-final replacement.
- [x] Test question punctuation and boundaries.
- [x] Test follow-up questions and pronouns.
- [x] Compare live transcripts against reference transcripts.

### Completion gate

- [x] A valid user can receive reliable final transcripts without exposing the managed Deepgram key.

## Phase 10 — Resume Document Extraction

### Supported documents

- [x] PDF.
- [x] DOCX.
- [x] TXT.
- [x] Decide whether to support scanned PDFs and OCR.

### Safety

- [x] Validate file extension.
- [x] Validate MIME type or file signature.
- [x] Enforce a file-size limit.
- [x] Reject unsupported formats.
- [x] Reject empty documents.
- [x] Handle corrupt documents.
- [x] Handle password-protected PDFs.
- [x] Restrict file selection to approved paths.
- [x] Clean temporary files.
- [x] Avoid logging document content.

### Extraction

- [x] Extract text.
- [x] Preserve page metadata.
- [x] Normalize whitespace.
- [x] Preserve useful section boundaries.
- [x] Calculate a document hash.
- [x] Detect degenerate extraction.
- [x] Display a safe extraction preview.
- [x] Test one-column and two-column resumes.

### Completion gate

- [x] Representative resumes produce readable and complete extracted text.

## Phase 11 — Structured Resume Parser

### Versioned schema

- [x] Identity.
- [x] Contact information.
- [x] Summary.
- [x] Work experience.
- [x] Projects.
- [x] Education.
- [x] Skills by category.
- [x] Achievements.
- [x] Certifications.
- [x] Languages.
- [x] Source evidence.
- [x] Extraction metadata.

### Parsing pipeline

- [x] Run heuristic parsing.
- [x] Run structured model extraction.
- [x] Validate output against the schema.
- [x] Normalize dates and technologies.
- [x] Preserve source text for every claim.
- [x] Detect degenerate model output.
- [x] Fall back to heuristic results when necessary.
- [x] Avoid inventing missing facts.
- [x] Mark uncertain fields.
- [x] Version parser output.

### User control

- [x] Show the parsed profile.
- [x] Allow field corrections.
- [x] Allow removal of incorrect fields.
- [x] Save approved changes.
- [x] Replace the old resume atomically on re-upload.
- [x] Remove derived profile data when a resume is deleted.
- [x] Prevent parser upgrades from silently overwriting user corrections.

### Evaluation

- [x] Build at least 20 anonymized resume fixtures.
- [x] Measure field-level accuracy.
- [x] Measure experience and project separation.
- [x] Measure skills extraction.
- [x] Measure source-evidence fidelity.
- [x] Test sparse and nontechnical resumes.
- [x] Test unusual formatting.

### Completion gate

- [x] The parsed profile is accurate enough for user approval before interview use.

## Phase 12 — Job Description Parser

- [x] Extract company.
- [x] Extract role title.
- [x] Extract seniority.
- [x] Extract employment type.
- [x] Extract responsibilities.
- [x] Extract required skills.
- [x] Extract preferred skills.
- [x] Extract years-of-experience requirements.
- [x] Extract technologies.
- [x] Extract education requirements.
- [x] Extract location and remote requirements.
- [x] Extract compensation only when explicitly present.
- [x] Preserve source evidence.
- [x] Mark missing information honestly.
- [x] Allow review and correction.
- [x] Replace an old JD atomically.
- [x] Invalidate dependent cached answers after replacement.

### Completion gate

- [x] JD-only questions can be answered from structured, source-backed evidence.

## Phase 13 — Profile and JD Persistence

- [x] Store original documents locally or according to the chosen privacy policy.
- [x] Store structured profile data.
- [x] Store structured JD data.
- [x] Store source spans.
- [x] Define the active resume.
- [x] Define the active JD.
- [x] Load active documents on startup.
- [x] Maintain user separation.
- [x] Delete derived nodes transactionally.
- [x] Clear stale in-memory caches after replacement or deletion.
- [x] Rebuild retrieval indexes when documents change.
- [x] Decide whether profile data remains local-only or is synchronized.
- [x] Encrypt sensitive local data where appropriate.

### Completion gate

- [x] Restarting the application restores the correct active resume and JD.

## Phase 14 — Question Routing

- [x] Identity questions use resume only.
- [x] Experience questions use resume only.
- [x] Project questions use resume only.
- [x] Education questions use resume only.
- [x] JD-summary questions use JD only.
- [x] JD-requirement questions use JD only.
- [x] Role-fit questions use resume and JD.
- [x] Gap-analysis questions use resume and JD.
- [x] Role-specific introductions use resume and JD.
- [x] General introductions use resume only.
- [x] Negotiation questions use only permitted compensation context.
- [x] Coding questions use neither resume nor JD.
- [x] General technical questions use neither unless explicitly requested.
- [x] Meeting questions use meeting and transcript context.
- [x] Reference-file modes respect their source boundaries.
- [x] Follow-ups preserve the correct previous subject.

### Regression suite

- [x] Preserve the existing 26 routing scenarios.
- [x] Add live-transcript variants.
- [x] Add STT-misspelled variants.
- [x] Add ambiguous pronouns.
- [x] Add rapid topic switching.
- [x] Add multipart questions.
- [x] Add coding questions during interview mode.
- [x] Add meeting questions with a loaded resume.

### Completion gate

- [x] Every route receives only its permitted context layers.

## Phase 15 — Evidence Selection and Prompt Construction

- [x] Select evidence based on the route.
- [x] Tag resume evidence as `profile_resume`.
- [x] Tag JD evidence as `profile_jd`.
- [x] Tag live transcript evidence separately.
- [x] Preserve trust level and source.
- [x] Include only relevant evidence.
- [x] Keep source blocks clearly separated.
- [x] Place system instructions before untrusted documents.
- [x] Treat uploaded documents as evidence, not instructions.
- [x] Represent missing evidence explicitly.
- [x] Prevent salary or private context from leaking into unrelated answers.
- [x] Record evidence diagnostics without recording raw content.

### Critical verification

For every answer, prove:

- [x] The intended route was selected.
- [x] The intended evidence was retrieved.
- [x] Evidence reached the final prompt.
- [x] The final answer used only allowed evidence.
- [x] Unsupported claims were rejected or qualified.

### Completion gate

- [x] The resume/JD evidence verifier passes end to end.

## Phase 16 — Remove Inaccurate-Answer Pathways

### Cached and AOT answer control

- [x] Find every cached or precomputed final-answer path.
- [x] Prevent stale introductions from bypassing fresh validation.
- [x] Invalidate cached answers after resume or JD changes.
- [x] Require current source-version IDs.
- [x] Permit caching retrieval artifacts, not unchecked final answers.
- [x] Run final-answer policy at actual emit sites.

### Previous-answer contamination

- [x] Label prior assistant suggestions separately.
- [x] Never treat prior suggestions as factual evidence.
- [x] Strip prior suggestions where they can contaminate grounding.
- [x] Preserve user and interviewer transcript context.
- [x] Keep conversational continuity without recycling unsupported claims.
- [x] Reset answer memory when the resume or JD changes.
- [x] Test topic switching.

### Completion gate

- [x] Repeated questions do not inherit unrelated facts from previous AI suggestions.

## Phase 17 — Final Answer Generation and Validation

- [x] Generate natural spoken answers.
- [x] Use first person for candidate responses.
- [x] Use STAR structure when appropriate.
- [x] Keep answers concise enough for live interviews.
- [x] Avoid robotic résumé recitation.
- [x] Do not invent employers, dates, metrics, tools, or achievements.
- [x] Admit when evidence is insufficient.
- [x] Distinguish required from preferred JD qualifications.
- [x] Avoid claiming unmet requirements.
- [x] Stream validated output to the overlay.
- [x] Detect provider errors and leaked JSON envelopes.
- [x] Validate named entities and numerical claims.
- [x] Validate output against selected evidence.
- [x] Fall back safely if validation fails.

### Completion gate

- [x] Every factual candidate claim is supported by approved resume or JD evidence.

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

- [x] Starting an interview requires authorization.
- [x] Provider startup succeeds before charging.
- [x] Partial transcripts do not create duplicate answers.
- [x] Final transcripts replace partial text.
- [x] Duplicate questions are deduplicated.
- [x] Follow-up questions retain relevant context.
- [x] Old suggestions do not contaminate new answers.
- [x] Reconnect uses the same business session.
- [x] Stopping closes audio and provider connections.
- [x] Final consumed seconds are reconciled.
- [x] Remaining balance refreshes.
- [x] Meeting mode remains unaffected.

### Completion gate

- [x] A live spoken question produces the same grounded result as its typed equivalent.

## Phase 19 — Business UI

- [x] Sign-in screen.
- [x] Google login button.
- [x] Account profile.
- [x] Free-trial explanation.
- [x] Remaining-time display.
- [x] Low-time warning.
- [x] Out-of-time state.
- [x] Session-pack pricing.
- [x] Unlimited pricing.
- [x] Checkout progress.
- [x] Purchase-success state.
- [x] Payment-pending state.
- [x] Purchase history.
- [x] Subscription state.
- [x] Customer portal.
- [x] Refund and support links.
- [x] Logout.
- [x] Account deletion.
- [x] Privacy controls.
- [x] Resume and JD deletion.

### Completion gate

- [x] Every entitlement state has a clear and accurate UI.

## Phase 20 — Privacy, Security, and Abuse Prevention

- [x] Keep the Supabase service-role key server-side.
- [x] Keep the Dodo API key server-side.
- [x] Keep the Dodo webhook secret server-side.
- [x] Keep the permanent Deepgram key server-side.
- [x] Keep managed LLM keys server-side.
- [x] Validate every Edge Function JWT.
- [x] Verify webhook signatures.
- [x] Rate-limit authentication and session creation.
- [x] Prevent credit replay.
- [x] Prevent concurrent double spending.
- [x] Redact resumes, JDs, transcripts, prompts, and tokens from logs.
- [x] Encrypt sensitive credentials.
- [x] Define data-retention periods.
- [x] Implement data export and deletion.
- [x] Add account and device abuse monitoring.
- [x] Add dependency and secret scans.
- [x] Review Electron IPC exposure.
- [x] Review navigation and external-link handling.

### Completion gate

- [x] A security review finds no client-controlled entitlement or provider-secret path.

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
