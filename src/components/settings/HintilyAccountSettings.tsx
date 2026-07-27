import React, { useEffect, useRef, useState } from 'react';
import { AlertCircle, CheckCircle2, LogIn, LogOut, RefreshCw, Trash2, UserRound } from 'lucide-react';
import type { HintilyAccountState, HintilyAuthStatus } from '../../types/electron';

const INITIAL: HintilyAuthStatus = { state: 'signed_out', user: null };
const CHECKOUT_BASELINE_KEY = 'hintily.checkoutBaselineRevision';

const storeCheckoutBaseline = (revision: string | null): void => {
  try {
    window.localStorage.setItem(CHECKOUT_BASELINE_KEY, JSON.stringify(revision));
  } catch {
    // Checkout still works if renderer storage is unavailable.
  }
};

const readCheckoutBaseline = (): string | null | undefined => {
  try {
    const stored = window.localStorage.getItem(CHECKOUT_BASELINE_KEY);
    if (stored === null) return undefined;
    const parsed = JSON.parse(stored);
    return parsed === null || typeof parsed === 'string' ? parsed : undefined;
  } catch {
    return undefined;
  }
};

const clearCheckoutBaseline = (): void => {
  try {
    window.localStorage.removeItem(CHECKOUT_BASELINE_KEY);
  } catch {
    // Nothing else is required when renderer storage is unavailable.
  }
};

export function HintilyAccountSettings(): React.ReactElement {
  const [status, setStatus] = useState<HintilyAuthStatus>(INITIAL);
  const [busy, setBusy] = useState<'signin' | 'signout' | 'delete' | 'refresh' | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [account, setAccount] = useState<HintilyAccountState | null>(null);
  const [accountLoading, setAccountLoading] = useState(false);
  const [checkoutBusy, setCheckoutBusy] = useState(false);
  const latestAccessRevision = useRef<string | null | undefined>(undefined);
  const checkoutBaselineRevision = useRef<string | null | undefined>(undefined);

  useEffect(() => {
    latestAccessRevision.current = account?.access_revision;
  }, [account]);

  useEffect(() => {
    let mounted = true;
    window.electronAPI.hintilyAuthGetStatus()
      .then((next) => mounted && setStatus(next))
      .catch(() => mounted && setMessage('Unable to load account status.'));
    const unsubscribe = window.electronAPI.onHintilyAuthChanged((next) => {
      if (mounted) setStatus(next);
    });
    return () => {
      mounted = false;
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    if (status.state !== 'signed_in') {
      setAccount(null);
      return;
    }
    let mounted = true;
    setAccountLoading(true);
    window.electronAPI.hintilyBusinessEnsureTrial()
      .then(result => {
        if (!mounted) return;
        if (result.ok) setAccount(result.data);
        else setMessage(result.offline ? 'Account time could not be verified while offline.' : `Unable to load access: ${result.error}`);
      })
      .catch(() => mounted && setMessage('Unable to load Hintily access.'))
      .finally(() => mounted && setAccountLoading(false));
    return () => { mounted = false; };
  }, [status.state]);

  useEffect(() => window.electronAPI.onHintilyCheckoutReturn(async ({ outcome }) => {
    if (outcome === 'cancel') {
      checkoutBaselineRevision.current = undefined;
      clearCheckoutBaseline();
      setMessage('Checkout was cancelled. No access was changed.');
      return;
    }
    setMessage('Payment received. Waiting for Dodo verification…');
    let baseline = checkoutBaselineRevision.current !== undefined
      ? checkoutBaselineRevision.current
      : readCheckoutBaseline();
    for (const delay of [500, 1_500, 3_000, 6_000]) {
      await new Promise(resolve => setTimeout(resolve, delay));
      const result = await window.electronAPI.hintilyBusinessGetState();
      if (result.ok) {
        setAccount(result.data);
        if (baseline === undefined) {
          clearCheckoutBaseline();
          setMessage('Account access refreshed after checkout.');
          return;
        }
        if (result.data.access_revision !== baseline) {
          checkoutBaselineRevision.current = undefined;
          clearCheckoutBaseline();
          setMessage('Access refreshed after checkout.');
          return;
        }
      }
    }
    checkoutBaselineRevision.current = undefined;
    clearCheckoutBaseline();
    setMessage('Payment is still being verified. Use Refresh session shortly.');
  }), []);

  const run = async (
    action: NonNullable<typeof busy>,
    operation: () => Promise<{ ok: boolean; status: HintilyAuthStatus; error?: string }>,
  ) => {
    setBusy(action);
    setMessage(null);
    try {
      const result = await operation();
      setStatus(result.status);
      if (!result.ok) setMessage(result.error || 'The account action could not be completed.');
    } catch {
      setMessage('The account action could not be completed.');
    } finally {
      setBusy(null);
    }
  };

  const signedIn = status.state === 'signed_in';
  const user = signedIn ? status.user : null;

  return (
    <div className="space-y-6 animated fadeIn max-w-2xl">
      <div>
        <h3 className="text-lg font-bold text-text-primary mb-1">Hintily account</h3>
        <p className="text-xs text-text-secondary">
          Sign in securely with Google to keep your trial, purchases, and session access linked to you.
        </p>
      </div>

      {status.state === 'unconfigured' && (
        <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-4 flex gap-3">
          <AlertCircle size={18} className="text-amber-500 shrink-0 mt-0.5" />
          <div>
            <p className="text-sm font-semibold text-text-primary">Account services need configuration</p>
            <p className="text-xs text-text-secondary mt-1">{status.error}</p>
          </div>
        </div>
      )}

      {user ? (
        <div className="rounded-xl border border-border-subtle bg-bg-subtle/30 p-5">
          <div className="flex items-center gap-4">
            {user.avatarUrl ? (
              <img src={user.avatarUrl} alt="" className="h-12 w-12 rounded-full" referrerPolicy="no-referrer" />
            ) : (
              <div className="h-12 w-12 rounded-full bg-accent-primary/15 text-accent-primary flex items-center justify-center">
                <UserRound size={22} />
              </div>
            )}
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <p className="text-sm font-semibold text-text-primary truncate">{user.displayName || 'Hintily user'}</p>
                <CheckCircle2 size={15} className="text-emerald-500 shrink-0" />
              </div>
              <p className="text-xs text-text-secondary truncate">{user.email || 'Google account'}</p>
            </div>
          </div>

          <div className="flex flex-wrap gap-2 mt-5">
            <button
              disabled={busy !== null}
              onClick={() => run('refresh', async () => {
                const authResult = await window.electronAPI.hintilyAuthRefresh();
                if (!authResult.ok || authResult.status.state !== 'signed_in') return authResult;
                const accountResult = await window.electronAPI.hintilyBusinessGetState();
                if (accountResult.ok) {
                  setAccount(accountResult.data);
                  return authResult;
                }
                return {
                  ...authResult,
                  ok: false,
                  error: `Unable to refresh access: ${accountResult.error}`,
                };
              })}
              className="inline-flex items-center gap-2 px-3 py-2 rounded-lg border border-border-subtle text-xs font-medium text-text-primary hover:bg-bg-subtle disabled:opacity-50"
            >
              <RefreshCw size={14} className={busy === 'refresh' ? 'animate-spin' : ''} /> Refresh session
            </button>
            <button
              disabled={busy !== null}
              onClick={() => run('signout', () => window.electronAPI.hintilyAuthSignOut())}
              className="inline-flex items-center gap-2 px-3 py-2 rounded-lg border border-border-subtle text-xs font-medium text-text-primary hover:bg-bg-subtle disabled:opacity-50"
            >
              <LogOut size={14} /> Sign out
            </button>
          </div>

          <div className="mt-5 rounded-lg border border-border-subtle p-4">
            <p className="text-xs text-text-secondary">Available managed session time</p>
            <p className="mt-1 text-xl font-bold text-text-primary">
              {accountLoading ? 'Loading…' : account?.unlimited
                ? 'Unlimited'
                : `${Math.floor((account?.remaining_seconds || 0) / 60)}m ${Math.floor((account?.remaining_seconds || 0) % 60)}s`}
            </p>
            {account && !account.unlimited && account.remaining_seconds <= 300 && account.remaining_seconds > 0 && (
              <p className="mt-1 text-xs text-amber-500">Less than five minutes remain.</p>
            )}
            {account && !account.unlimited && account.remaining_seconds === 0 && (
              <p className="mt-1 text-xs text-red-400">No managed session time remains.</p>
            )}
            <div className="mt-3 flex flex-wrap gap-2">
              {[
                ['session_1', 'Buy 1 session'],
                ['session_3', 'Buy 3 sessions'],
                ['session_7', 'Buy 7 sessions'],
                ['session_12', 'Buy 12 sessions'],
                ['unlimited_monthly', 'Unlimited monthly'],
                ['unlimited_quarterly', 'Unlimited quarterly'],
                ['unlimited_yearly', 'Unlimited yearly'],
                ['unlimited_lifetime', 'Unlimited lifetime'],
              ].map(([code, label]) => (
                <button
                  key={code}
                  disabled={busy !== null || checkoutBusy}
                  onClick={async () => {
                    if (checkoutBusy) return;
                    setCheckoutBusy(true);
                    setMessage(null);
                    try {
                      let baseline = latestAccessRevision.current;
                      if (baseline === undefined) {
                        const state = await window.electronAPI.hintilyBusinessGetState();
                        if (!state.ok) {
                          setMessage('Checkout could not start because current access could not be verified.');
                          return;
                        }
                        setAccount(state.data);
                        baseline = state.data.access_revision;
                        latestAccessRevision.current = baseline;
                      }
                      checkoutBaselineRevision.current = baseline;
                      storeCheckoutBaseline(baseline);
                      const result = await window.electronAPI.hintilyBusinessCreateCheckout(code);
                      if (!result.ok) {
                        checkoutBaselineRevision.current = undefined;
                        clearCheckoutBaseline();
                        setMessage(`Checkout could not start: ${result.error}`);
                      }
                      else setMessage('Checkout opened. Access will update after Dodo confirms payment.');
                    } catch {
                      checkoutBaselineRevision.current = undefined;
                      clearCheckoutBaseline();
                      setMessage('Checkout could not start. Please try again.');
                    } finally {
                      setCheckoutBusy(false);
                    }
                  }}
                  className="rounded-lg border border-border-subtle px-3 py-2 text-xs font-medium text-text-primary hover:bg-bg-subtle disabled:opacity-50"
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
        </div>
      ) : status.state !== 'unconfigured' ? (
        <div className="rounded-xl border border-border-subtle bg-bg-subtle/30 p-5">
          <p className="text-sm font-semibold text-text-primary">Continue with Google</p>
          <p className="text-xs text-text-secondary mt-1 mb-4">
            Your browser will open for authentication. Hintily never receives your Google password.
          </p>
          <button
            disabled={busy !== null || status.state === 'signing_in'}
            onClick={() => run('signin', () => window.electronAPI.hintilyAuthSignInWithGoogle())}
            className="inline-flex items-center gap-2 px-4 py-2.5 rounded-lg bg-text-primary text-bg-main text-sm font-semibold disabled:opacity-50"
          >
            {busy === 'signin' || status.state === 'signing_in'
              ? <RefreshCw size={16} className="animate-spin" />
              : <LogIn size={16} />}
            Sign in with Google
          </button>
        </div>
      ) : null}

      {message && (
        <div className="rounded-lg border border-red-500/25 bg-red-500/10 px-4 py-3 text-xs text-red-400">
          {message}
        </div>
      )}

      {user && (
        <div className="pt-5 border-t border-border-subtle">
          <h4 className="text-sm font-semibold text-text-primary">Delete account</h4>
          <p className="text-xs text-text-secondary mt-1 mb-3">
            Permanently removes your Hintily cloud account. Local meeting data is managed separately.
          </p>
          <button
            disabled={busy !== null}
            onClick={() => {
              if (window.confirm('Permanently delete your Hintily account? This cannot be undone.')) {
                void run('delete', () => window.electronAPI.hintilyAuthDeleteAccount());
              }
            }}
            className="inline-flex items-center gap-2 px-3 py-2 rounded-lg border border-red-500/30 text-xs font-medium text-red-400 hover:bg-red-500/10 disabled:opacity-50"
          >
            <Trash2 size={14} /> Delete account
          </button>
        </div>
      )}
    </div>
  );
}
