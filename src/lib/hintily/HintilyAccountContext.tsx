import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type {
  HintilyAccountState,
  HintilyAuthResult,
  HintilyAuthStatus,
  HintilyPurchaseSummary,
} from '../../types/electron';
import type { HintilyProductCode } from '../../config/hintilyProducts';

type AccountBusyAction = 'signin' | 'signout' | 'delete' | 'refresh' | null;
type PurchaseHistoryState = 'idle' | 'loading' | 'loaded' | 'error';
type NoticeKind = 'info' | 'success' | 'error';

export interface HintilyAccountNotice {
  kind: NoticeKind;
  text: string;
}

interface CheckoutBaseline {
  userId: string;
  revision: string | null;
}

export interface HintilyAccountContextValue {
  status: HintilyAuthStatus;
  authLoading: boolean;
  account: HintilyAccountState | null;
  accountLoading: boolean;
  busy: AccountBusyAction;
  checkoutBusy: boolean;
  purchases: HintilyPurchaseSummary[];
  purchaseHistoryState: PurchaseHistoryState;
  notice: HintilyAccountNotice | null;
  signedIn: boolean;
  hasAccess: boolean;
  signInWithGoogle: () => Promise<boolean>;
  signOut: () => Promise<boolean>;
  deleteAccount: () => Promise<boolean>;
  refreshAccess: (refreshAuth?: boolean) => Promise<boolean>;
  reconcileActiveSession: () => Promise<boolean>;
  refreshPurchases: () => Promise<boolean>;
  startCheckout: (productCode: HintilyProductCode) => Promise<boolean>;
  clearNotice: () => void;
}

const INITIAL_STATUS: HintilyAuthStatus = { state: 'signed_out', user: null };
const CHECKOUT_BASELINE_KEY = 'hintily.checkoutBaseline.v2';
const CHECKOUT_POLL_DELAYS_MS = [500, 1_500, 3_000, 6_000] as const;

const HintilyAccountContext = createContext<HintilyAccountContextValue | null>(null);

const storeCheckoutBaseline = (baseline: CheckoutBaseline): void => {
  try {
    window.localStorage.setItem(CHECKOUT_BASELINE_KEY, JSON.stringify(baseline));
  } catch {
    // Checkout remains usable when renderer storage is unavailable.
  }
};

const readCheckoutBaseline = (): CheckoutBaseline | null => {
  try {
    const raw = window.localStorage.getItem(CHECKOUT_BASELINE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (typeof parsed.userId !== 'string') return null;
    if (parsed.revision !== null && typeof parsed.revision !== 'string') return null;
    return { userId: parsed.userId, revision: parsed.revision as string | null };
  } catch {
    return null;
  }
};

const clearCheckoutBaseline = (): void => {
  try {
    window.localStorage.removeItem(CHECKOUT_BASELINE_KEY);
  } catch {
    // No cleanup is possible or required.
  }
};

const accountHasAccess = (account: HintilyAccountState | null): boolean => Boolean(
  account?.unlimited
  || account?.free_session_available
  || (account?.paid_session_count ?? 0) > 0
  || account?.active_session,
);

export function HintilyAccountProvider(
  { children }: { children: React.ReactNode },
): React.ReactElement {
  const [status, setStatus] = useState<HintilyAuthStatus>(INITIAL_STATUS);
  const [authLoading, setAuthLoading] = useState(true);
  const [account, setAccount] = useState<HintilyAccountState | null>(null);
  const [accountLoading, setAccountLoading] = useState(false);
  const [busy, setBusy] = useState<AccountBusyAction>(null);
  const [checkoutBusy, setCheckoutBusy] = useState(false);
  const [purchases, setPurchases] = useState<HintilyPurchaseSummary[]>([]);
  const [purchaseHistoryState, setPurchaseHistoryState] =
    useState<PurchaseHistoryState>('idle');
  const [notice, setNotice] = useState<HintilyAccountNotice | null>(null);

  const mountedRef = useRef(true);
  const activeUserIdRef = useRef<string | null>(null);
  const requestGenerationRef = useRef(0);
  const checkoutGenerationRef = useRef(0);
  const authActionRef = useRef<AccountBusyAction>(null);
  const checkoutInFlightRef = useRef(false);
  const initialAuthReadyRef = useRef<Promise<HintilyAuthStatus> | null>(null);

  const setAccountValue = useCallback((next: HintilyAccountState | null): void => {
    setAccount(next);
  }, []);

  const applyAuthStatus = useCallback((next: HintilyAuthStatus): void => {
    const nextUserId = next.state === 'signed_in' ? next.user.id : null;
    if (activeUserIdRef.current !== nextUserId) {
      requestGenerationRef.current += 1;
      checkoutGenerationRef.current += 1;
      setAccountValue(null);
      setPurchases([]);
      setPurchaseHistoryState('idle');
      setAccountLoading(false);
      setCheckoutBusy(false);
      checkoutInFlightRef.current = false;
      setNotice(null);
    }
    activeUserIdRef.current = nextUserId;
    setStatus(next);
    setAuthLoading(false);
  }, [setAccountValue]);

  const refreshPurchases = useCallback(async (): Promise<boolean> => {
    const requestedUserId = activeUserIdRef.current;
    if (!requestedUserId) {
      setPurchases([]);
      setPurchaseHistoryState('idle');
      return false;
    }
    const generation = ++requestGenerationRef.current;
    setPurchaseHistoryState('loading');
    try {
      const result = await window.electronAPI.hintilyBusinessGetPurchases();
      if (
        !mountedRef.current
        || activeUserIdRef.current !== requestedUserId
        || requestGenerationRef.current !== generation
      ) return false;
      if (!result.ok) {
        setPurchaseHistoryState('error');
        return false;
      }
      setPurchases(result.data.purchases);
      setPurchaseHistoryState('loaded');
      return true;
    } catch {
      if (
        mountedRef.current
        && activeUserIdRef.current === requestedUserId
        && requestGenerationRef.current === generation
      ) setPurchaseHistoryState('error');
      return false;
    }
  }, []);

  const loadAccess = useCallback(async (
    userId: string,
    ensureTrial: boolean,
    options: { showLoading?: boolean; preserveOnError?: boolean } = {},
  ): Promise<boolean> => {
    const showLoading = options.showLoading !== false;
    const generation = ++requestGenerationRef.current;
    if (showLoading) setAccountLoading(true);
    try {
      const result = ensureTrial
        ? await window.electronAPI.hintilyBusinessEnsureTrial()
        : await window.electronAPI.hintilyBusinessGetState();
      if (
        !mountedRef.current
        || activeUserIdRef.current !== userId
        || requestGenerationRef.current !== generation
      ) return false;
      if (!result.ok) {
        if (!options.preserveOnError) setAccountValue(null);
        setNotice({
          kind: 'error',
          text: result.offline
            ? 'Hintily access could not be verified while offline.'
            : `Hintily access could not be verified (${result.error}).`,
        });
        return false;
      }
      setAccountValue(result.data);
      return true;
    } catch {
      if (
        mountedRef.current
        && activeUserIdRef.current === userId
        && requestGenerationRef.current === generation
      ) {
        if (!options.preserveOnError) setAccountValue(null);
        setNotice({ kind: 'error', text: 'Hintily access could not be loaded.' });
      }
      return false;
    } finally {
      if (
        mountedRef.current
        && activeUserIdRef.current === userId
        && requestGenerationRef.current === generation
      ) {
        if (showLoading) setAccountLoading(false);
      }
    }
  }, [setAccountValue]);

  const refreshAccess = useCallback(async (refreshAuth = false): Promise<boolean> => {
    let userId = activeUserIdRef.current;
    setNotice(null);
    if (refreshAuth) {
      if (authActionRef.current) return false;
      authActionRef.current = 'refresh';
      setBusy('refresh');
      try {
        const authResult = await window.electronAPI.hintilyAuthRefresh();
        applyAuthStatus(authResult.status);
        if (!authResult.ok || authResult.status.state !== 'signed_in') {
          setNotice({
            kind: 'error',
            text: authResult.error || 'Your Google session could not be refreshed.',
          });
          return false;
        }
        userId = authResult.status.user.id;
      } catch {
        setNotice({ kind: 'error', text: 'Your Google session could not be refreshed.' });
        return false;
      } finally {
        authActionRef.current = null;
        if (mountedRef.current) setBusy(null);
      }
    }
    if (!userId) {
      setNotice({ kind: 'error', text: 'Sign in with Google to verify Hintily access.' });
      return false;
    }
    const success = await loadAccess(userId, false);
    if (success) void refreshPurchases();
    return success;
  }, [applyAuthStatus, loadAccess, refreshPurchases]);

  const reconcileActiveSession = useCallback(async (): Promise<boolean> => {
    const userId = activeUserIdRef.current;
    if (!userId) return false;
    return loadAccess(userId, false, { showLoading: false, preserveOnError: true });
  }, [loadAccess]);

  const runAuthAction = useCallback(async (
    action: Exclude<AccountBusyAction, 'refresh' | null>,
    operation: () => Promise<HintilyAuthResult>,
  ): Promise<boolean> => {
    if (authActionRef.current) return false;
    authActionRef.current = action;
    setBusy(action);
    setNotice(null);
    try {
      const result = await operation();
      applyAuthStatus(result.status);
      if (!result.ok) {
        setNotice({
          kind: 'error',
          text: result.error || 'The account action could not be completed.',
        });
      }
      return result.ok;
    } catch {
      setNotice({ kind: 'error', text: 'The account action could not be completed.' });
      return false;
    } finally {
      authActionRef.current = null;
      if (mountedRef.current) setBusy(null);
    }
  }, [applyAuthStatus]);

  const pollCheckout = useCallback(async (
    checkoutUserId: string,
    baselineRevision: string | null,
    checkoutGeneration: number,
  ): Promise<boolean> => {
    for (const delay of CHECKOUT_POLL_DELAYS_MS) {
      await new Promise(resolve => window.setTimeout(resolve, delay));
      if (
        !mountedRef.current
        || activeUserIdRef.current !== checkoutUserId
        || checkoutGenerationRef.current !== checkoutGeneration
      ) return false;
      const result = await window.electronAPI.hintilyBusinessGetState();
      if (
        !mountedRef.current
        || activeUserIdRef.current !== checkoutUserId
        || checkoutGenerationRef.current !== checkoutGeneration
      ) return false;
      if (!result.ok) continue;
      setAccountValue(result.data);
      if (result.data.access_revision !== baselineRevision) {
        clearCheckoutBaseline();
        setNotice({ kind: 'success', text: 'Your verified Hintily access is ready.' });
        void refreshPurchases();
        return true;
      }
    }
    clearCheckoutBaseline();
    setNotice({
      kind: 'info',
      text: 'Payment is still being verified. Use Refresh Access shortly.',
    });
    return false;
  }, [refreshPurchases, setAccountValue]);

  const startCheckout = useCallback(async (
    productCode: HintilyProductCode,
  ): Promise<boolean> => {
    const userId = activeUserIdRef.current;
    if (!userId || checkoutInFlightRef.current) return false;
    checkoutInFlightRef.current = true;
    setCheckoutBusy(true);
    setNotice(null);
    try {
      // Always establish the baseline immediately before checkout. Reusing a
      // previously rendered revision could mistake an unrelated earlier grant
      // for confirmation of this new payment.
      const state = await window.electronAPI.hintilyBusinessGetState();
      if (!state.ok || activeUserIdRef.current !== userId) {
        setNotice({
          kind: 'error',
          text: 'Checkout could not start because current access could not be verified.',
        });
        return false;
      }
      const current = state.data;
      setAccountValue(current);
      storeCheckoutBaseline({ userId, revision: current.access_revision });
      const result = await window.electronAPI.hintilyBusinessCreateCheckout(productCode);
      if (activeUserIdRef.current !== userId) return false;
      if (!result.ok) {
        clearCheckoutBaseline();
        setNotice({ kind: 'error', text: `Checkout could not start (${result.error}).` });
        return false;
      }
      setNotice({
        kind: 'info',
        text: 'Checkout opened. Access will update after Dodo verifies payment.',
      });
      return true;
    } catch {
      clearCheckoutBaseline();
      setNotice({ kind: 'error', text: 'Checkout could not start. Please try again.' });
      return false;
    } finally {
      checkoutInFlightRef.current = false;
      if (mountedRef.current) setCheckoutBusy(false);
    }
  }, [setAccountValue]);

  useEffect(() => {
    mountedRef.current = true;
    let active = true;
    const authReady = window.electronAPI.hintilyAuthGetStatus();
    initialAuthReadyRef.current = authReady;
    authReady
      .then(next => active && applyAuthStatus(next))
      .catch(() => {
        if (!active) return;
        setAuthLoading(false);
        setNotice({ kind: 'error', text: 'Unable to load Hintily account status.' });
      });
    const unsubscribe = window.electronAPI.onHintilyAuthChanged(next => {
      if (active) applyAuthStatus(next);
    });
    return () => {
      active = false;
      mountedRef.current = false;
      requestGenerationRef.current += 1;
      checkoutGenerationRef.current += 1;
      unsubscribe();
    };
  }, [applyAuthStatus]);

  const signedInUserId = status.state === 'signed_in' ? status.user.id : null;
  useEffect(() => {
    if (!signedInUserId) return;
    void loadAccess(signedInUserId, true).then(success => {
      if (success) void refreshPurchases();
    });
  }, [loadAccess, refreshPurchases, signedInUserId]);

  useEffect(() => window.electronAPI.onHintilyCheckoutReturn(async ({ outcome }) => {
    if (outcome === 'cancel') {
      checkoutGenerationRef.current += 1;
      clearCheckoutBaseline();
      setNotice({ kind: 'info', text: 'Checkout was cancelled. Your access was not changed.' });
      return;
    }
    if (!activeUserIdRef.current && initialAuthReadyRef.current) {
      await initialAuthReadyRef.current.catch(() => null);
    }
    const userId = activeUserIdRef.current;
    const baseline = readCheckoutBaseline();
    if (!userId || !baseline || baseline.userId !== userId) {
      clearCheckoutBaseline();
      setNotice({
        kind: 'error',
        text: 'Sign in with the account that started checkout, then refresh access.',
      });
      return;
    }
    const generation = ++checkoutGenerationRef.current;
    setNotice({ kind: 'info', text: 'Payment received. Waiting for Dodo verification…' });
    void pollCheckout(userId, baseline.revision, generation);
  }), [pollCheckout]);

  const value = useMemo<HintilyAccountContextValue>(() => ({
    status,
    authLoading,
    account,
    accountLoading,
    busy,
    checkoutBusy,
    purchases,
    purchaseHistoryState,
    notice,
    signedIn: status.state === 'signed_in',
    hasAccess: accountHasAccess(account),
    signInWithGoogle: () => runAuthAction(
      'signin',
      () => window.electronAPI.hintilyAuthSignInWithGoogle(),
    ),
    signOut: () => runAuthAction('signout', () => window.electronAPI.hintilyAuthSignOut()),
    deleteAccount: () => runAuthAction(
      'delete',
      () => window.electronAPI.hintilyAuthDeleteAccount(),
    ),
    refreshAccess,
    reconcileActiveSession,
    refreshPurchases,
    startCheckout,
    clearNotice: () => setNotice(null),
  }), [
    account,
    accountLoading,
    authLoading,
    busy,
    checkoutBusy,
    notice,
    purchases,
    purchaseHistoryState,
    refreshAccess,
    reconcileActiveSession,
    refreshPurchases,
    runAuthAction,
    startCheckout,
    status,
  ]);

  return (
    <HintilyAccountContext.Provider value={value}>
      {children}
    </HintilyAccountContext.Provider>
  );
}

export function useHintilyAccount(): HintilyAccountContextValue {
  const value = useContext(HintilyAccountContext);
  if (!value) throw new Error('useHintilyAccount must be used within HintilyAccountProvider');
  return value;
}
