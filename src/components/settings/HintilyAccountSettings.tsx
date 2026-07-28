import React, { useEffect, useRef, useState } from 'react';
import { AlertCircle, CheckCircle2, ExternalLink, LogIn, LogOut, RefreshCw, Trash2, UserRound } from 'lucide-react';
import type { HintilyAccountState, HintilyAuthStatus, HintilyPurchaseSummary } from '../../types/electron';

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

const formatPurchaseAmount = (purchase: HintilyPurchaseSummary): string => {
  if (purchase.amount_minor == null || !purchase.currency) return 'Amount unavailable';
  try {
    const formatter = new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency: purchase.currency,
    });
    const minorUnitDigits = formatter.resolvedOptions().maximumFractionDigits ?? 2;
    return formatter.format(purchase.amount_minor / (10 ** minorUnitDigits));
  } catch {
    return `${(purchase.amount_minor / 100).toFixed(2)} ${purchase.currency}`;
  }
};

export function HintilyAccountSettings(): React.ReactElement {
  const [status, setStatus] = useState<HintilyAuthStatus>(INITIAL);
  const [busy, setBusy] = useState<'signin' | 'signout' | 'delete' | 'refresh' | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [account, setAccount] = useState<HintilyAccountState | null>(null);
  const [accountLoading, setAccountLoading] = useState(false);
  const [checkoutBusy, setCheckoutBusy] = useState(false);
  const [purchases, setPurchases] = useState<HintilyPurchaseSummary[]>([]);
  const [purchaseHistoryState, setPurchaseHistoryState] = useState<'idle' | 'loading' | 'loaded' | 'error'>('idle');
  const latestAccessRevision = useRef<string | null | undefined>(undefined);
  const checkoutBaselineRevision = useRef<string | null | undefined>(undefined);
  const activeUserId = useRef<string | null>(null);
  const initialAuthReady = useRef<Promise<HintilyAuthStatus> | null>(null);
  const purchaseRequestGeneration = useRef(0);
  const signedInUserId = status.state === 'signed_in' ? status.user.id : null;

  const refreshPurchases = async (): Promise<boolean> => {
    const requestedForUserId = activeUserId.current;
    if (!requestedForUserId) return false;
    const requestGeneration = ++purchaseRequestGeneration.current;
    setPurchaseHistoryState('loading');
    try {
      const history = await window.electronAPI.hintilyBusinessGetPurchases();
      if (
        activeUserId.current !== requestedForUserId
        || purchaseRequestGeneration.current !== requestGeneration
      ) return false;
      if (!history.ok) {
        setPurchaseHistoryState('error');
        return false;
      }
      setPurchases(history.data.purchases);
      setPurchaseHistoryState('loaded');
      return true;
    } catch {
      if (
        activeUserId.current === requestedForUserId
        && purchaseRequestGeneration.current === requestGeneration
      ) {
        setPurchaseHistoryState('error');
      }
      return false;
    }
  };

  useEffect(() => {
    latestAccessRevision.current = account?.access_revision;
  }, [account]);

  useEffect(() => {
    let mounted = true;
    const statusPromise = window.electronAPI.hintilyAuthGetStatus();
    initialAuthReady.current = statusPromise;
    statusPromise
      .then((next) => {
        if (!mounted) return;
        activeUserId.current = next.state === 'signed_in' ? next.user.id : null;
        setStatus(next);
      })
      .catch(() => mounted && setMessage('Unable to load account status.'));
    const unsubscribe = window.electronAPI.onHintilyAuthChanged((next) => {
      if (mounted) {
        activeUserId.current = next.state === 'signed_in' ? next.user.id : null;
        setStatus(next);
      }
    });
    return () => {
      mounted = false;
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    if (!signedInUserId) {
      purchaseRequestGeneration.current += 1;
      setAccount(null);
      setPurchases([]);
      setPurchaseHistoryState('idle');
      setAccountLoading(false);
      return;
    }
    const requestedForUserId = signedInUserId;
    let mounted = true;
    setAccount(null);
    setPurchases([]);
    setPurchaseHistoryState('loading');
    setAccountLoading(true);
    window.electronAPI.hintilyBusinessEnsureTrial()
      .then(async result => {
        if (!mounted || activeUserId.current !== requestedForUserId) return;
        if (result.ok) {
          setAccount(result.data);
          // Session access is ready; purchase history is supplemental and must
          // not keep the available-time UI behind its independent retry budget.
          setAccountLoading(false);
          void refreshPurchases();
        }
        else {
          setPurchaseHistoryState('error');
          setMessage(result.offline ? 'Account time could not be verified while offline.' : `Unable to load access: ${result.error}`);
        }
      })
      .catch(() => {
        if (mounted && activeUserId.current === requestedForUserId) {
          setPurchaseHistoryState('error');
          setMessage('Unable to load Hintily access.');
        }
      })
      .finally(() => {
        if (mounted && activeUserId.current === requestedForUserId) {
          setAccountLoading(false);
        }
      });
    return () => { mounted = false; };
  }, [signedInUserId]);

  useEffect(() => window.electronAPI.onHintilyCheckoutReturn(async ({ outcome }) => {
    if (outcome === 'cancel') {
      checkoutBaselineRevision.current = undefined;
      clearCheckoutBaseline();
      setMessage('Checkout was cancelled. No access was changed.');
      return;
    }
    if (!activeUserId.current && initialAuthReady.current) {
      await initialAuthReady.current.catch(() => null);
    }
    const checkoutUserId = activeUserId.current;
    if (!checkoutUserId) {
      setMessage('Sign in again before refreshing checkout access.');
      return;
    }
    setMessage('Payment received. Waiting for Dodo verification…');
    let baseline = checkoutBaselineRevision.current !== undefined
      ? checkoutBaselineRevision.current
      : readCheckoutBaseline();
    for (const delay of [500, 1_500, 3_000, 6_000]) {
      await new Promise(resolve => setTimeout(resolve, delay));
      if (activeUserId.current !== checkoutUserId) return;
      const result = await window.electronAPI.hintilyBusinessGetState();
      if (activeUserId.current !== checkoutUserId) return;
      if (result.ok) {
        setAccount(result.data);
        if (baseline === undefined) {
          // Without the pre-checkout revision there is no trustworthy value to
          // compare against. Keep polling, but never turn an unchanged account
          // state into a false "access refreshed" confirmation.
          continue;
        }
        if (result.data.access_revision !== baseline) {
          checkoutBaselineRevision.current = undefined;
          clearCheckoutBaseline();
          setMessage('Access refreshed after checkout.');
          // Access verification is complete. History has its own loading/error
          // state and must not delay this confirmation through its retry budget.
          void refreshPurchases();
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
                  // Purchase history is supplemental. Refresh it independently
                  // without delaying or changing the successful access result.
                  void refreshPurchases();
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

          <div className="mt-5 rounded-xl border border-border-subtle bg-bg-card/40 p-4">
            <p className="text-xs text-text-secondary">Hintily access</p>
            <p className="mt-1 text-xl font-bold text-text-primary">
              {accountLoading ? 'Loading…' : account?.unlimited
                ? 'Unlimited sessions'
                : account?.active_session
                  ? `${Math.floor((account.remaining_seconds || 0) / 60)}m ${Math.floor((account.remaining_seconds || 0) % 60)}s in this session`
                  : `${account?.paid_session_count || 0} paid session${account?.paid_session_count === 1 ? '' : 's'} available`}
            </p>
            {account?.free_session_available && !account.active_session && (
              <p className="mt-1 text-xs text-emerald-500">Your single-use 20-minute free session is available.</p>
            )}
            {account?.unlimited_entitlement && (
              <p className={`mt-1 text-xs ${
                account.unlimited ? 'text-emerald-500' : 'text-amber-500'
              }`}>
                {account.unlimited_entitlement.plan_name || account.unlimited_entitlement.plan_code}
                {' · '}
                {account.unlimited_entitlement.status.replace('_', ' ')}
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
            {account?.active_session && !account.unlimited && account.remaining_seconds <= 300 && account.remaining_seconds > 0 && (
              <p className="mt-1 text-xs text-amber-500">Less than five minutes remain.</p>
            )}
            {account && !account.unlimited && !account.free_session_available
              && account.paid_session_count === 0 && !account.active_session && (
              <p className="mt-1 text-xs text-red-400">No sessions remain. Purchase a session to continue.</p>
            )}
            <p className="mt-2 text-[11px] leading-relaxed text-text-tertiary">
              Each purchased session can run for up to 60 minutes. Ending early consumes that session,
              and unused time does not carry forward.
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
              {[
                ['session_1', '1 session', '₹499'],
                ['session_3', '3 sessions', '₹1,099'],
                ['session_7', '7 sessions', '₹1,899'],
                ['session_12', '12 sessions', '₹2,799'],
                ['unlimited_monthly', 'Monthly unlimited', '₹3,399'],
                ['unlimited_quarterly', 'Quarterly unlimited', '₹7,497'],
                ['unlimited_yearly', 'Yearly unlimited', '₹25,188'],
                ['unlimited_lifetime', 'Lifetime unlimited', '₹35,000'],
              ].map(([code, label, price]) => (
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
                  className="min-w-[138px] rounded-xl border border-border-subtle bg-bg-subtle/30 px-3 py-2.5 text-left transition-all hover:border-accent-primary/40 hover:bg-bg-subtle disabled:opacity-50"
                >
                  <span className="block text-xs font-semibold text-text-primary">{label}</span>
                  <span className="mt-0.5 block text-[11px] text-accent-primary">{price}</span>
                </button>
              ))}
            </div>
          </div>

          <div className="mt-5 rounded-lg border border-border-subtle p-4">
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-sm font-semibold text-text-primary">Purchase history</p>
                <p className="text-xs text-text-secondary">Dodo payment records linked to this account.</p>
              </div>
              <button
                onClick={async () => {
                  setMessage(null);
                  try {
                    const result = await window.electronAPI.hintilyOpenSupport();
                    if (!result.success) {
                      setMessage('Support could not be opened. Please try again shortly.');
                    }
                  } catch {
                    setMessage('Support could not be opened. Please try again shortly.');
                  }
                }}
                className="inline-flex items-center gap-1.5 text-xs font-medium text-accent-primary"
              >
                Refunds & support <ExternalLink size={12} />
              </button>
            </div>
            {purchaseHistoryState === 'loading' ? (
              <p className="mt-3 text-xs text-text-secondary">Loading purchase history…</p>
            ) : purchaseHistoryState === 'error' ? (
              <div className="mt-3 flex items-center justify-between gap-3">
                <p className="text-xs text-amber-500">Purchase history is temporarily unavailable.</p>
                <button
                  onClick={() => void refreshPurchases()}
                  className="text-xs font-medium text-accent-primary"
                >
                  Retry
                </button>
              </div>
            ) : purchases.length === 0 ? (
              <p className="mt-3 text-xs text-text-secondary">No purchases yet.</p>
            ) : (
              <div className="mt-3 space-y-2">
                {purchases.map(purchase => {
                  const amount = formatPurchaseAmount(purchase);
                  return (
                    <div key={purchase.id} className="flex items-center justify-between gap-3 rounded-lg bg-bg-subtle/50 px-3 py-2">
                      <div className="min-w-0">
                        <p className="truncate text-xs font-medium text-text-primary">
                          {purchase.product_code.replace(/_/g, ' ')}
                        </p>
                        <p className="text-[11px] text-text-secondary">
                          {new Date(purchase.purchased_at || purchase.created_at).toLocaleDateString()}
                        </p>
                      </div>
                      <div className="text-right">
                        <p className="text-xs text-text-primary">{amount}</p>
                        <p className="text-[11px] capitalize text-text-secondary">
                          {purchase.status.replace(/_/g, ' ')}
                        </p>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
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
