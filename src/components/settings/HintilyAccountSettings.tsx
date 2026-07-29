import React from 'react';
import {
  AlertCircle,
  CheckCircle2,
  LogIn,
  LogOut,
  RefreshCw,
  Trash2,
  UserRound,
} from 'lucide-react';
import { useHintilyAccount } from '../../lib/hintily/HintilyAccountContext';

const formatRemainingTime = (seconds: number): string => {
  const safe = Math.max(0, Math.floor(Number.isFinite(seconds) ? seconds : 0));
  return `${Math.floor(safe / 60)}m ${safe % 60}s`;
};

export function HintilyAccountSettings(): React.ReactElement {
  const {
    status,
    authLoading,
    account,
    accountLoading,
    busy,
    notice,
    signInWithGoogle,
    signOut,
    deleteAccount,
    refreshAccess,
  } = useHintilyAccount();

  const user = status.state === 'signed_in' ? status.user : null;

  return (
    <div className="mx-auto max-w-2xl space-y-6 animated fadeIn">
      <div>
        <h3 className="mb-1 text-lg font-bold text-text-primary">Hintily account</h3>
        <p className="text-xs text-text-secondary">
          Sign in securely with Google to keep your free session, purchases, and access linked to you.
        </p>
      </div>

      {authLoading && (
        <div className="flex items-center gap-2 rounded-xl border border-border-subtle bg-bg-subtle/30 p-4 text-xs text-text-secondary">
          <RefreshCw size={15} className="animate-spin text-accent-primary" />
          Loading account…
        </div>
      )}

      {status.state === 'unconfigured' && (
        <div className="flex gap-3 rounded-xl border border-amber-500/30 bg-amber-500/10 p-4">
          <AlertCircle size={18} className="mt-0.5 shrink-0 text-amber-500" />
          <div>
            <p className="text-sm font-semibold text-text-primary">Account services need configuration</p>
            <p className="mt-1 text-xs text-text-secondary">{status.error}</p>
          </div>
        </div>
      )}

      {!authLoading && user ? (
        <div className="overflow-hidden rounded-2xl border border-border-subtle bg-gradient-to-b from-bg-elevated to-bg-subtle/20 shadow-[0_18px_50px_rgba(0,0,0,0.14)]">
          <div className="p-6">
          <div className="flex items-center gap-4">
            {user.avatarUrl ? (
              <img
                src={user.avatarUrl}
                alt=""
                className="h-12 w-12 rounded-full"
                referrerPolicy="no-referrer"
              />
            ) : (
              <div className="flex h-12 w-12 items-center justify-center rounded-full bg-accent-primary/15 text-accent-primary">
                <UserRound size={22} />
              </div>
            )}
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <p className="truncate text-sm font-semibold text-text-primary">
                  {user.displayName || 'Hintily user'}
                </p>
                <CheckCircle2 size={15} className="shrink-0 text-emerald-500" />
              </div>
              <p className="truncate text-xs text-text-secondary">{user.email || 'Google account'}</p>
            </div>
          </div>

          <div className="mt-5 flex flex-wrap gap-2">
            <button
              type="button"
              disabled={busy !== null || accountLoading}
              onClick={() => void refreshAccess(true)}
              className="inline-flex items-center gap-2 rounded-lg border border-border-subtle px-3 py-2 text-xs font-medium text-text-primary hover:bg-bg-subtle disabled:opacity-50"
            >
              <RefreshCw size={14} className={busy === 'refresh' ? 'animate-spin' : ''} />
              Refresh access
            </button>
            <button
              type="button"
              disabled={busy !== null}
              onClick={() => void signOut()}
              className="inline-flex items-center gap-2 rounded-lg border border-border-subtle px-3 py-2 text-xs font-medium text-text-primary hover:bg-bg-subtle disabled:opacity-50"
            >
              <LogOut size={14} /> Sign out
            </button>
          </div>

          <div className="mt-6 rounded-xl border border-border-subtle bg-bg-card/40 p-4">
            <p className="text-xs text-text-secondary">Hintily access</p>
            <p className="mt-1 text-xl font-bold text-text-primary">
              {accountLoading
                ? 'Loading…'
                : account?.unlimited
                  ? 'Unlimited sessions'
                  : account?.active_session
                    ? `${formatRemainingTime(account.remaining_seconds)} in this session`
                    : account?.free_session_available
                      ? `1 free session · ${account.paid_session_count} paid session${account.paid_session_count === 1 ? '' : 's'}`
                      : `${account?.paid_session_count || 0} paid session${account?.paid_session_count === 1 ? '' : 's'} available`}
            </p>

            {account?.active_session && (
              <p className="mt-1 text-xs text-text-secondary">
                Active in {account.active_session.surface === 'meeting' ? 'Meeting' : 'Interview Helper'}
                {' · '}ending early consumes this single-use session
              </p>
            )}
            {account?.free_session_available && !account.active_session && (
              <p className="mt-1 text-xs text-emerald-500">
                Your single-use 20-minute free session is available.
              </p>
            )}
            {account?.unlimited_entitlement && (
              <p className={`mt-1 text-xs ${account.unlimited ? 'text-emerald-500' : 'text-amber-500'}`}>
                {account.unlimited_entitlement.plan_name || account.unlimited_entitlement.plan_code}
                {' · '}{account.unlimited_entitlement.status.replace('_', ' ')}
                {' · '}
                {account.unlimited_entitlement.lifetime
                  ? 'No expiry'
                  : account.unlimited_entitlement.ends_at
                    ? `Access until ${new Intl.DateTimeFormat(undefined, {
                      dateStyle: 'medium',
                      timeStyle: 'short',
                    }).format(new Date(account.unlimited_entitlement.ends_at))}`
                    : 'Expiry unavailable'}
              </p>
            )}
            {account?.active_session
              && !account.unlimited
              && account.remaining_seconds > 0
              && account.remaining_seconds <= 300 && (
                <p className="mt-1 text-xs text-amber-500">Less than five minutes remain.</p>
              )}
            {account
              && !account.unlimited
              && !account.free_session_available
              && account.paid_session_count === 0
              && !account.active_session && (
                <p className="mt-1 text-xs text-red-400">
                  No sessions remain. Purchase access to continue.
                </p>
              )}

            <p className="mt-2 text-[11px] leading-relaxed text-text-tertiary">
              Each purchased session can run for up to 60 minutes. Ending early consumes that
              session, and unused time does not carry forward.
            </p>
            <p className="mt-3 text-[11px] font-medium text-accent-primary">
              Manage plans and billing from the Subscription tab.
            </p>
          </div>
          </div>
        </div>
      ) : !authLoading && status.state !== 'unconfigured' ? (
        <div className="rounded-xl border border-border-subtle bg-bg-subtle/30 p-5">
          <p className="text-sm font-semibold text-text-primary">Continue with Google</p>
          <p className="mb-4 mt-1 text-xs text-text-secondary">
            Your browser will open for authentication. Hintily never receives your Google password.
          </p>
          <button
            type="button"
            disabled={busy !== null || status.state === 'signing_in'}
            onClick={() => void signInWithGoogle()}
            className="inline-flex items-center gap-2 rounded-lg bg-text-primary px-4 py-2.5 text-sm font-semibold text-bg-main disabled:opacity-50"
          >
            {busy === 'signin' || status.state === 'signing_in'
              ? <RefreshCw size={16} className="animate-spin" />
              : <LogIn size={16} />}
            Sign in with Google
          </button>
        </div>
      ) : null}

      {notice && (
        <div className={`rounded-lg border px-4 py-3 text-xs ${
          notice.kind === 'error'
            ? 'border-red-500/25 bg-red-500/10 text-red-400'
            : notice.kind === 'success'
              ? 'border-emerald-500/25 bg-emerald-500/10 text-emerald-500'
              : 'border-blue-500/25 bg-blue-500/10 text-blue-400'
        }`}>
          {notice.text}
        </div>
      )}

      {user && (
        <div className="border-t border-border-subtle pt-5">
          <h4 className="text-sm font-semibold text-text-primary">Delete account</h4>
          <p className="mb-3 mt-1 text-xs text-text-secondary">
            Permanently removes your Hintily cloud account. Local session data is managed separately.
          </p>
          <button
            type="button"
            disabled={busy !== null}
            onClick={() => {
              if (window.confirm('Permanently delete your Hintily account? This cannot be undone.')) {
                void deleteAccount();
              }
            }}
            className="inline-flex items-center gap-2 rounded-lg border border-red-500/30 px-3 py-2 text-xs font-medium text-red-400 hover:bg-red-500/10 disabled:opacity-50"
          >
            <Trash2 size={14} /> Delete account
          </button>
        </div>
      )}
    </div>
  );
}
