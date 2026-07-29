import React, { useState } from 'react';
import {
  CheckCircle2,
  Clock3,
  Crown,
  ExternalLink,
  History,
  LogIn,
  RefreshCw,
  ShieldCheck,
  Sparkles,
} from 'lucide-react';
import type { HintilyPurchaseSummary } from '../../types/electron';
import { useHintilyAccount } from '../../lib/hintily/HintilyAccountContext';
import { HintilyPlanGrid } from '../hintily/HintilyPlanGrid';

const formatPurchaseAmount = (purchase: HintilyPurchaseSummary): string => {
  if (purchase.amount_minor == null || !purchase.currency) return 'Amount unavailable';
  try {
    return new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency: purchase.currency,
    }).format(purchase.amount_minor / 100);
  } catch {
    return `${(purchase.amount_minor / 100).toFixed(2)} ${purchase.currency}`;
  }
};

const formatRemainingTime = (seconds: number): string => {
  const safe = Math.max(0, Math.floor(Number.isFinite(seconds) ? seconds : 0));
  return `${Math.floor(safe / 60)}m ${safe % 60}s`;
};

const purchaseStatusClass = (status: HintilyPurchaseSummary['status']): string => {
  switch (status) {
    case 'paid':
      return 'text-emerald-500';
    case 'pending':
    case 'refunded':
      return 'text-text-secondary';
    case 'partially_refunded':
    case 'disputed':
      return 'text-amber-500';
    case 'failed':
      return 'text-red-400';
  }
};

export function HintilySubscriptionSettings(): React.ReactElement {
  const [supportError, setSupportError] = useState<string | null>(null);
  const {
    account,
    accountLoading,
    busy,
    purchases,
    purchaseHistoryState,
    notice,
    signedIn,
    signInWithGoogle,
    refreshAccess,
    refreshPurchases,
  } = useHintilyAccount();

  const accessTitle = !signedIn
    ? 'Sign in to view your access'
    : accountLoading
    ? 'Loading your access…'
    : account?.unlimited
      ? account.unlimited_entitlement?.plan_name || 'Unlimited access'
      : account?.active_session
        ? `${formatRemainingTime(account.remaining_seconds)} remaining`
        : account?.free_session_available
          ? 'Free 20-minute session'
          : `${account?.paid_session_count || 0} session${account?.paid_session_count === 1 ? '' : 's'} available`;

  return (
    <div className="mx-auto max-w-3xl space-y-6 animated fadeIn">
      <div>
        <div className="mb-2 flex items-center gap-2 text-accent-primary">
          <Crown size={17} />
          <span className="text-[11px] font-bold uppercase tracking-[0.16em]">Hintily access</span>
        </div>
        <h3 className="text-xl font-bold text-text-primary">Subscription & sessions</h3>
        <p className="mt-1 max-w-2xl text-xs leading-relaxed text-text-secondary">
          Choose single-use sessions or unlimited access. Purchases are linked to your Google
          account and activated only after secure payment confirmation.
        </p>
      </div>

      <section className="relative overflow-hidden rounded-2xl border border-accent-primary/25 bg-gradient-to-br from-accent-primary/[0.12] via-bg-elevated to-bg-elevated p-5 shadow-[0_18px_50px_rgba(0,0,0,0.16)]">
        <div className="pointer-events-none absolute -right-12 -top-16 h-44 w-44 rounded-full bg-accent-primary/15 blur-3xl" />
        <div className="relative flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-4">
            <span className="flex h-12 w-12 items-center justify-center rounded-2xl border border-accent-primary/20 bg-accent-primary/15 text-accent-primary">
              {account?.unlimited ? <Crown size={22} /> : <Clock3 size={22} />}
            </span>
            <div>
              <p className="text-[11px] font-medium text-text-secondary">Current access</p>
              <p className="mt-0.5 text-xl font-bold text-text-primary">{accessTitle}</p>
              <p className="mt-1 text-[11px] text-text-secondary">
                {!signedIn
                  ? 'Your access and purchases are securely linked to your Google account.'
                  : account?.unlimited
                  ? account.unlimited_entitlement?.lifetime
                    ? 'Lifetime access · no expiry'
                    : account.unlimited_entitlement?.ends_at
                      ? `Active until ${new Date(account.unlimited_entitlement.ends_at).toLocaleDateString()}`
                      : 'Unlimited plan active'
                  : account?.free_session_available
                    ? 'Your one-time free session is ready to use.'
                    : 'Each paid session can run for up to 60 minutes.'}
              </p>
            </div>
          </div>
          <button
            type="button"
            disabled={!signedIn || busy !== null || accountLoading}
            onClick={() => void refreshAccess(true)}
            className="inline-flex items-center gap-2 rounded-xl border border-border-subtle bg-bg-main/40 px-3.5 py-2 text-xs font-semibold text-text-primary transition hover:border-accent-primary/35 hover:bg-bg-subtle disabled:opacity-50"
          >
            <RefreshCw size={14} className={busy === 'refresh' ? 'animate-spin' : ''} />
            Refresh access
          </button>
        </div>
      </section>

      {notice && (
        <div
          role={notice.kind === 'error' ? 'alert' : 'status'}
          aria-live={notice.kind === 'error' ? 'assertive' : 'polite'}
          className={`rounded-xl border px-4 py-3 text-xs ${
            notice.kind === 'error'
              ? 'border-red-500/25 bg-red-500/10 text-red-400'
              : notice.kind === 'success'
                ? 'border-emerald-500/25 bg-emerald-500/10 text-emerald-500'
                : 'border-blue-500/25 bg-blue-500/10 text-blue-400'
          }`}
        >
          {notice.text}
        </div>
      )}

      <section>
        <div className="mb-4 flex items-end justify-between gap-4">
          <div>
            <h4 className="flex items-center gap-2 text-sm font-semibold text-text-primary">
              <Sparkles size={15} className="text-accent-primary" /> Choose your access
            </h4>
            <p className="mt-1 text-[11px] text-text-secondary">
              Session packs never auto-renew. Unlimited plans follow the billing period shown.
            </p>
          </div>
          <span className="hidden items-center gap-1.5 text-[10px] text-text-tertiary sm:inline-flex">
            <ShieldCheck size={13} className="text-emerald-500" /> Secure checkout by Dodo Payments
          </span>
        </div>
        {signedIn ? (
          <HintilyPlanGrid />
        ) : (
          <div className="relative overflow-hidden rounded-2xl border border-border-subtle bg-gradient-to-br from-bg-elevated to-bg-subtle/25 p-5">
            <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <p className="text-sm font-semibold text-text-primary">Sign in before choosing a plan</p>
                <p className="mt-1 max-w-md text-[11px] leading-relaxed text-text-secondary">
                  This lets Hintily bind the checkout and verified Dodo payment to the correct account.
                </p>
              </div>
              <button
                type="button"
                disabled={busy !== null}
                onClick={() => void signInWithGoogle()}
                className="inline-flex shrink-0 items-center justify-center gap-2 rounded-xl bg-accent-primary px-4 py-2.5 text-xs font-semibold text-on-accent shadow-[0_8px_24px_rgba(0,0,0,0.18)] transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50"
              >
                <LogIn size={14} />
                Continue with Google
              </button>
            </div>
          </div>
        )}
        <p className="mt-3 text-[10px] leading-relaxed text-text-tertiary">
          A single-use session is consumed once started, even if ended early. Unused minutes do
          not carry forward. Unlimited access does not consume sessions while active.
        </p>
      </section>

      {signedIn && (
      <section className="overflow-hidden rounded-2xl border border-border-subtle bg-bg-elevated/65">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border-subtle px-5 py-4">
          <div>
            <h4 className="flex items-center gap-2 text-sm font-semibold text-text-primary">
              <History size={15} className="text-accent-primary" /> Billing history
            </h4>
            <p className="mt-1 text-[11px] text-text-secondary">Verified Dodo payment records.</p>
          </div>
          <button
            type="button"
            onClick={async () => {
              setSupportError(null);
              try {
                const result = await window.electronAPI.hintilyOpenSupport();
                if (!result.success) setSupportError('Support could not be opened.');
              } catch {
                setSupportError('Support could not be opened.');
              }
            }}
            className="inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium text-accent-primary transition hover:bg-accent-primary/10"
          >
            Refunds & support <ExternalLink size={12} />
          </button>
        </div>
        {supportError && <p className="mx-5 mt-3 text-xs text-red-400">{supportError}</p>}

        <div className="p-3">
          {purchaseHistoryState === 'loading' ? (
            <p className="px-2 py-5 text-center text-xs text-text-secondary">Loading billing history…</p>
          ) : purchaseHistoryState === 'error' ? (
            <div className="flex items-center justify-between gap-3 rounded-xl bg-amber-500/[0.07] px-4 py-3">
              <p className="text-xs text-amber-500">Billing history is temporarily unavailable.</p>
              <button type="button" onClick={() => void refreshPurchases()} className="text-xs font-semibold text-accent-primary">
                Retry
              </button>
            </div>
          ) : purchases.length === 0 ? (
            <div className="rounded-xl border border-dashed border-border-subtle px-4 py-7 text-center">
              <CheckCircle2 size={19} className="mx-auto text-text-tertiary" />
              <p className="mt-2 text-xs font-medium text-text-primary">No purchases yet</p>
              <p className="mt-1 text-[11px] text-text-tertiary">Your verified purchases will appear here.</p>
            </div>
          ) : (
            <div className="space-y-1">
              {purchases.map(purchase => (
                <div key={purchase.id} className="flex items-center justify-between gap-4 rounded-xl px-3 py-2.5 transition hover:bg-bg-subtle/60">
                  <div className="min-w-0">
                    <p className="truncate text-xs font-semibold capitalize text-text-primary">
                      {purchase.product_code.replace(/_/g, ' ')}
                    </p>
                    <p className="mt-0.5 text-[10px] text-text-tertiary">
                      {new Date(purchase.purchased_at || purchase.created_at).toLocaleDateString(undefined, {
                        year: 'numeric', month: 'short', day: 'numeric',
                      })}
                    </p>
                  </div>
                  <div className="text-right">
                    <p className="text-xs font-semibold text-text-primary">{formatPurchaseAmount(purchase)}</p>
                    <p className={`mt-0.5 text-[10px] capitalize ${purchaseStatusClass(purchase.status)}`}>
                      {purchase.status.replace(/_/g, ' ')}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </section>
      )}
    </div>
  );
}
