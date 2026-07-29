import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  Bot,
  Clock3,
  Headphones,
  Loader2,
  Mic,
  RefreshCw,
  Square,
} from 'lucide-react';
import { useHintilyAccount } from '../../lib/hintily/HintilyAccountContext';
import type { HintilyManagedRuntimeStatus } from '../../types/electron';

type AudioState = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'failed';

const RECONCILE_INTERVAL_MS = 10_000;

const formatClock = (seconds: number): string => {
  const safe = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const remainder = safe % 60;
  return hours
    ? `${hours}:${String(minutes).padStart(2, '0')}:${String(remainder).padStart(2, '0')}`
    : `${minutes}:${String(remainder).padStart(2, '0')}`;
};

const statusTone = (ready: boolean, failed = false): string =>
  failed ? 'text-red-400' : ready ? 'text-emerald-500' : 'text-amber-400';

export function HintilyActiveSessionPanel(): React.ReactElement | null {
  const { account, refreshAccess, reconcileActiveSession } = useHintilyAccount();
  const active = account?.active_session;
  const [runtime, setRuntime] = useState<HintilyManagedRuntimeStatus | null>(null);
  const [audio, setAudio] = useState<Record<'interviewer' | 'user', AudioState>>({
    interviewer: 'idle',
    user: 'idle',
  });
  const [displayRemaining, setDisplayRemaining] = useState<number | null>(null);
  const [warning, setWarning] = useState('');
  const [ending, setEnding] = useState(false);
  const [confirmEnd, setConfirmEnd] = useState(false);
  const [error, setError] = useState('');
  const anchorRef = useRef<{ seconds: number; monotonicMs: number; running: boolean } | null>(null);

  const unlimited = Boolean(account?.unlimited);
  const maximumSeconds = active?.maximum_seconds ?? null;
  const serverRemaining = active && maximumSeconds != null
    ? Math.max(0, maximumSeconds - active.consumed_seconds)
    : active && !unlimited
      ? Math.max(0, account?.remaining_seconds ?? 0)
      : null;

  useEffect(() => {
    if (!active || unlimited || serverRemaining == null) {
      anchorRef.current = null;
      setDisplayRemaining(null);
      return;
    }
    anchorRef.current = {
      seconds: serverRemaining,
      monotonicMs: performance.now(),
      running: active.status === 'active',
    };
    setDisplayRemaining(serverRemaining);
  }, [
    active?.id,
    active?.status,
    active?.consumed_seconds,
    serverRemaining,
    unlimited,
  ]);

  useEffect(() => {
    if (!active || unlimited) return undefined;
    const timer = window.setInterval(() => {
      const anchor = anchorRef.current;
      if (!anchor) return;
      const elapsed = anchor.running
        ? Math.floor((performance.now() - anchor.monotonicMs) / 1000)
        : 0;
      setDisplayRemaining(Math.max(0, anchor.seconds - elapsed));
    }, 1_000);
    return () => window.clearInterval(timer);
  }, [active?.id, unlimited]);

  useEffect(() => {
    if (!active) return undefined;
    let mounted = true;
    const reconcile = async (): Promise<void> => {
      await reconcileActiveSession();
      try {
        const next = await window.electronAPI.hintilySessionGetRuntimeStatus();
        if (mounted) {
          setRuntime(next);
          setAudio(previous => ({
            interviewer: next.interviewerReady ? 'connected' : previous.interviewer,
            user: next.userReady ? 'connected' : previous.user,
          }));
        }
      } catch {
        // The account state remains authoritative even if local diagnostics fail.
      }
    };
    void reconcile();
    const interval = window.setInterval(() => void reconcile(), RECONCILE_INTERVAL_MS);
    const removeStt = window.electronAPI.onSttStatusChanged(data => {
      setAudio(previous => ({
        ...previous,
        [data.channel]: data.state === 'awaiting-audio' ? 'connecting' : data.state,
      }));
    });
    const removeWarning = window.electronAPI.onHintilyTimeWarning(({ remainingSeconds }) => {
      if (remainingSeconds <= 0) {
        setWarning('This session has ended because its authorized time was exhausted.');
      } else {
        setWarning(`${formatClock(remainingSeconds)} remains in this session.`);
      }
      void reconcile();
    });
    return () => {
      mounted = false;
      window.clearInterval(interval);
      removeStt();
      removeWarning();
    };
  }, [active?.id, reconcileActiveSession]);

  const accessType = useMemo(() => {
    if (!account) return 'Unavailable';
    if (account.unlimited) return account.unlimited_entitlement?.plan_name || 'Unlimited';
    if (account.trial_remaining_seconds > 0) return 'One-time free session';
    return 'Paid single-use session';
  }, [account]);

  if (!active) return null;

  const surfaceLabel = active.surface === 'meeting' ? 'Meeting' : 'Interview Helper';
  const aiReady = runtime?.aiReady === true;
  const phase = runtime?.phase || (active.status === 'active' ? 'active' : 'connecting');

  const endSession = async (): Promise<void> => {
    if (!confirmEnd && !unlimited) {
      setConfirmEnd(true);
      return;
    }
    setEnding(true);
    setError('');
    try {
      const result = await window.electronAPI.hintilySessionEndActive();
      if (!result.ok) throw new Error(result.error || 'session_completion_failed');
      setConfirmEnd(false);
      await refreshAccess(false);
    } catch (endError) {
      setError(endError instanceof Error ? endError.message : 'Could not end the active session.');
    } finally {
      setEnding(false);
    }
  };

  return (
    <div className="mt-4 rounded-xl border border-blue-500/25 bg-blue-500/[0.06] p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-[0.13em] text-blue-400">
            {phase === 'active' ? 'Active session' : 'Recoverable session'}
          </p>
          <h3 className="mt-1 text-sm font-semibold text-text-primary">{surfaceLabel}</h3>
          <p className="mt-1 text-[11px] text-text-secondary">
            {accessType} · Server status: {active.status}
          </p>
        </div>
        <div className="text-right">
          {unlimited ? (
            <p className="text-sm font-semibold text-emerald-500">Unlimited access</p>
          ) : (
            <>
              <p className="font-mono text-xl font-semibold tabular-nums text-text-primary">
                {formatClock(displayRemaining ?? serverRemaining ?? 0)}
              </p>
              <p className="text-[10px] text-text-tertiary">
                {maximumSeconds == null ? 'Server-authorized remaining time' : `${formatClock(maximumSeconds)} maximum`}
              </p>
            </>
          )}
        </div>
      </div>

      <div className="mt-4 grid gap-2 sm:grid-cols-3">
        <ProviderStatus icon={Bot} label="Managed AI" state={aiReady ? 'connected' : phase} />
        <ProviderStatus icon={Headphones} label="System audio" state={audio.interviewer} />
        <ProviderStatus icon={Mic} label="Microphone" state={audio.user} />
      </div>

      {(warning || confirmEnd || error) && (
        <div className={`mt-3 flex items-start gap-2 rounded-lg border px-3 py-2 text-[11px] ${
          error
            ? 'border-red-500/25 bg-red-500/10 text-red-400'
            : 'border-amber-500/25 bg-amber-500/10 text-amber-400'
        }`}>
          <AlertTriangle size={13} className="mt-0.5 shrink-0" />
          <span>
            {error || warning || 'Ending now consumes this entire single-use session. Unused time cannot be recovered.'}
          </span>
        </div>
      )}

      <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
        <p className="inline-flex items-center gap-1.5 text-[10px] text-text-tertiary">
          <RefreshCw size={11} /> Reconciled with Hintily every 10 seconds
        </p>
        <div className="flex gap-2">
          {confirmEnd && (
            <button type="button" onClick={() => setConfirmEnd(false)}
              className="rounded-lg border border-border-subtle px-3 py-1.5 text-[11px] text-text-secondary hover:bg-bg-subtle">
              Keep session
            </button>
          )}
          <button
            type="button"
            disabled={ending}
            onClick={() => void endSession()}
            className="inline-flex items-center gap-1.5 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-1.5 text-[11px] font-medium text-red-400 hover:bg-red-500/15 disabled:opacity-50"
          >
            {ending ? <Loader2 size={12} className="animate-spin" /> : <Square size={11} />}
            {confirmEnd ? 'Confirm end session' : 'End session'}
          </button>
        </div>
      </div>
    </div>
  );
}

function ProviderStatus({
  icon: Icon,
  label,
  state,
}: {
  icon: typeof Clock3;
  label: string;
  state: string;
}): React.ReactElement {
  const connected = state === 'connected' || state === 'active';
  const failed = state === 'failed';
  const labelState = connected
    ? 'Connected'
    : failed
      ? 'Failed'
      : state === 'reconnecting'
        ? 'Reconnecting'
        : state === 'idle'
          ? 'Waiting'
          : 'Connecting';
  return (
    <div className="flex items-center gap-2 rounded-lg border border-border-subtle bg-bg-primary/30 px-3 py-2">
      <Icon size={14} className={statusTone(connected, failed)} />
      <div>
        <p className="text-[10px] text-text-tertiary">{label}</p>
        <p className={`text-[11px] font-medium ${statusTone(connected, failed)}`}>{labelState}</p>
      </div>
    </div>
  );
}
