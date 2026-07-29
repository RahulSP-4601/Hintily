import React from 'react';
import {
  AlertCircle,
  CheckCircle2,
  Clock3,
  LogIn,
  LogOut,
  MessageSquareText,
  RefreshCw,
  Sparkles,
  UserRound,
} from 'lucide-react';
import { useHintilyAccount } from '../../lib/hintily/HintilyAccountContext';
import { HintilyPlanGrid } from './HintilyPlanGrid';
import { HintilyDetailedSessionSetup } from './HintilyDetailedSessionSetup';
import { HintilyActiveSessionPanel } from './HintilyActiveSessionPanel';
import type { HintilyLauncherStartRequest } from '../../lib/hintily/launcherSession';

export type HintilyLauncherSurface = 'interview_helper' | 'meeting';

interface LauncherSessionSetupProps {
  surface: HintilyLauncherSurface;
  localSessionActive: boolean;
  onSurfaceChange: (surface: HintilyLauncherSurface) => void;
  onStart: (request: HintilyLauncherStartRequest) => Promise<{
    success: boolean;
    error?: string;
    code?: string;
  }>;
}

const formatDuration = (seconds: number): string => {
  const safe = Math.max(0, Math.floor(Number.isFinite(seconds) ? seconds : 0));
  const minutes = Math.floor(safe / 60);
  const remainder = safe % 60;
  return remainder ? `${minutes}m ${remainder}s` : `${minutes} minutes`;
};

const accessLabel = (
  account: ReturnType<typeof useHintilyAccount>['account'],
): string => {
  if (!account) return 'Access unavailable';
  if (account.active_session) {
    return `${formatDuration(account.remaining_seconds)} remaining in active session`;
  }
  if (account.unlimited) return account.unlimited_entitlement?.plan_name || 'Unlimited sessions';
  if (account.free_session_available) return 'Free 20-minute session';
  if (account.paid_session_count > 0) {
    return `${account.paid_session_count} paid session${account.paid_session_count === 1 ? '' : 's'} available`;
  }
  return 'No sessions available';
};

export function LauncherSessionSetup({
  surface,
  localSessionActive,
  onSurfaceChange,
  onStart,
}: LauncherSessionSetupProps): React.ReactElement {
  const {
    status,
    authLoading,
    account,
    accountLoading,
    busy,
    notice,
    signedIn,
    hasAccess,
    signInWithGoogle,
    signOut,
    refreshAccess,
  } = useHintilyAccount();

  const user = status.state === 'signed_in' ? status.user : null;
  const activeSurface = account?.active_session?.surface;
  const selectionLocked = Boolean(account?.active_session);

  if (authLoading) {
    return (
      <section
        aria-label="Loading Hintily account"
        className="rounded-2xl border border-border-subtle bg-bg-elevated/70 p-6"
      >
        <div className="flex items-center gap-3 text-sm text-text-secondary">
          <RefreshCw size={17} className="animate-spin text-accent-primary" />
          Loading your Hintily account…
        </div>
      </section>
    );
  }

  if (status.state === 'unconfigured') {
    return (
      <section className="rounded-2xl border border-amber-500/30 bg-amber-500/10 p-6">
        <div className="flex items-start gap-3">
          <AlertCircle size={19} className="mt-0.5 shrink-0 text-amber-500" />
          <div>
            <h2 className="text-sm font-semibold text-text-primary">Account services need configuration</h2>
            <p className="mt-1 text-xs text-text-secondary">{status.error}</p>
          </div>
        </div>
      </section>
    );
  }

  if (!signedIn) {
    return (
      <section
        aria-labelledby="hintily-signin-title"
        className="relative overflow-hidden rounded-2xl border border-border-subtle bg-bg-elevated p-6"
      >
        <div className="pointer-events-none absolute -right-16 -top-24 h-52 w-52 rounded-full bg-blue-500/15 blur-3xl" />
        <div className="relative flex flex-col gap-5 md:flex-row md:items-center md:justify-between">
          <div className="max-w-xl">
            <div className="mb-3 flex h-10 w-10 items-center justify-center rounded-xl bg-blue-500/15 text-blue-400">
              <UserRound size={20} />
            </div>
            <h2 id="hintily-signin-title" className="text-lg font-semibold text-text-primary">
              Sign in to set up Hintily
            </h2>
            <p className="mt-1 text-sm leading-relaxed text-text-secondary">
              Interview Helper, Meeting setup, your free session, and purchased access are
              available only after secure Google authentication.
            </p>
          </div>
          <button
            type="button"
            disabled={busy !== null || status.state === 'signing_in'}
            onClick={() => void signInWithGoogle()}
            className="inline-flex shrink-0 items-center justify-center gap-2 rounded-full bg-gradient-to-b from-sky-400 via-sky-500 to-blue-600 px-5 py-3 text-sm font-semibold text-white shadow-[0_5px_18px_rgba(14,165,233,0.35)] transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {busy === 'signin' || status.state === 'signing_in'
              ? <RefreshCw size={16} className="animate-spin" />
              : <LogIn size={16} />}
            Continue with Google
          </button>
        </div>
        {notice && (
          <p className={`relative mt-4 text-xs ${
            notice.kind === 'error' ? 'text-red-400' : 'text-text-secondary'
          }`}>
            {notice.text}
          </p>
        )}
      </section>
    );
  }

  if (accountLoading || !account) {
    return (
      <section className="rounded-2xl border border-border-subtle bg-bg-elevated/75 p-6">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-blue-500/15 text-blue-400">
              {accountLoading
                ? <RefreshCw size={18} className="animate-spin" />
                : <AlertCircle size={18} />}
            </span>
            <div>
              <h2 className="text-sm font-semibold text-text-primary">
                {accountLoading ? 'Verifying Hintily access…' : 'Access could not be verified'}
              </h2>
              <p className="mt-1 text-xs text-text-secondary">
                Session setup remains locked until the server confirms your free, paid, or unlimited access.
              </p>
            </div>
          </div>
          <div className="flex gap-2">
            {!accountLoading && (
              <button
                type="button"
                disabled={busy !== null}
                onClick={() => void refreshAccess(true)}
                className="inline-flex items-center gap-1.5 rounded-lg border border-border-subtle px-3 py-2 text-xs font-medium text-text-primary hover:bg-bg-subtle disabled:opacity-50"
              >
                <RefreshCw size={13} className={busy === 'refresh' ? 'animate-spin' : ''} />
                Retry
              </button>
            )}
            <button
              type="button"
              disabled={busy !== null}
              onClick={() => void signOut()}
              className="inline-flex items-center gap-1.5 rounded-lg border border-border-subtle px-3 py-2 text-xs font-medium text-text-secondary hover:bg-bg-subtle disabled:opacity-50"
            >
              <LogOut size={13} /> Sign out
            </button>
          </div>
        </div>
        {notice && (
          <p className={`mt-3 text-xs ${notice.kind === 'error' ? 'text-red-400' : 'text-text-secondary'}`}>
            {notice.text}
          </p>
        )}
      </section>
    );
  }

  return (
    <section
      aria-labelledby="hintily-session-setup-title"
      className="relative overflow-hidden rounded-[22px] border border-emerald-500/20 bg-bg-elevated p-6 shadow-[0_28px_80px_rgba(0,0,0,0.32),0_0_0_1px_rgba(16,185,129,0.025),inset_0_1px_0_rgba(255,255,255,0.055)]"
    >
      <div className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-emerald-300/30 to-transparent" />
      <div className="pointer-events-none absolute -left-24 top-16 h-72 w-72 rounded-full bg-emerald-400/[0.065] blur-3xl" />
      <div className="pointer-events-none absolute -right-24 top-0 h-64 w-64 rounded-full bg-teal-400/[0.045] blur-3xl" />
      <div className="relative">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-accent-primary">
            Session setup
          </p>
          <h2 id="hintily-session-setup-title" className="mt-1 text-lg font-semibold text-text-primary">
            What are you joining?
          </h2>
          <p className="mt-1 text-xs text-text-secondary">
            Select a Hintily experience. Detailed context and audio setup follow in the next phases.
          </p>
        </div>

        <div className="flex items-center gap-2 rounded-full border border-border-subtle bg-bg-primary/50 py-1 pl-1 pr-2">
          {user?.avatarUrl ? (
            <img
              src={user.avatarUrl}
              alt=""
              referrerPolicy="no-referrer"
              className="h-7 w-7 rounded-full"
            />
          ) : (
            <span className="flex h-7 w-7 items-center justify-center rounded-full bg-accent-primary/15 text-accent-primary">
              <UserRound size={14} />
            </span>
          )}
          <span className="max-w-[150px] truncate text-[11px] font-medium text-text-secondary">
            {user?.displayName || user?.email || 'Google account'}
          </span>
          <button
            type="button"
            disabled={busy !== null}
            onClick={() => void signOut()}
            className="rounded-full p-1.5 text-text-tertiary transition hover:bg-bg-subtle hover:text-text-primary disabled:opacity-50"
            aria-label="Sign out of Hintily"
            title="Sign out"
          >
            <LogOut size={13} />
          </button>
        </div>
      </div>

      <div className="mt-5 grid gap-3 md:grid-cols-2">
        {([
          {
            value: 'interview_helper' as const,
            title: 'Interview Helper',
            description: 'Interview modes with resume, job description, company, and role context.',
            icon: Sparkles,
            accent: 'blue',
          },
          {
            value: 'meeting' as const,
            title: 'Meeting',
            description: 'Team, sales, recruiting, lecture, general, and custom meeting modes.',
            icon: MessageSquareText,
            accent: 'violet',
          },
        ]).map(option => {
          const selected = surface === option.value;
          const unavailable = selectionLocked
            && (activeSurface ? activeSurface !== option.value : surface !== option.value);
          const Icon = option.icon;
          return (
            <button
              key={option.value}
              type="button"
              disabled={unavailable}
              aria-pressed={selected}
              onClick={() => onSurfaceChange(option.value)}
              className={`rounded-xl border p-4 text-left transition-all ${
                selected
                  ? option.accent === 'blue'
                    ? 'border-blue-400/60 bg-blue-500/10 shadow-[0_0_0_1px_rgba(96,165,250,0.08)]'
                    : 'border-violet-400/60 bg-violet-500/10 shadow-[0_0_0_1px_rgba(167,139,250,0.08)]'
                  : 'border-border-subtle bg-bg-primary/25 hover:border-text-tertiary/40 hover:bg-bg-subtle/60'
              } disabled:cursor-not-allowed disabled:opacity-40`}
            >
              <span className="flex items-start gap-3">
                <span className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${
                  option.accent === 'blue'
                    ? 'bg-blue-500/15 text-blue-400'
                    : 'bg-violet-500/15 text-violet-400'
                }`}>
                  <Icon size={18} />
                </span>
                <span>
                  <span className="flex items-center gap-2 text-sm font-semibold text-text-primary">
                    {option.title}
                    {selected && <CheckCircle2 size={14} className="text-emerald-500" />}
                  </span>
                  <span className="mt-1 block text-[11px] leading-relaxed text-text-secondary">
                    {option.description}
                  </span>
                </span>
              </span>
            </button>
          );
        })}
      </div>

      <div className={`mt-4 rounded-xl border p-4 ${
        hasAccess
          ? 'border-emerald-500/25 bg-emerald-500/[0.06]'
          : 'border-amber-500/25 bg-amber-500/[0.06]'
      }`}>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <span className={`flex h-8 w-8 items-center justify-center rounded-lg ${
              hasAccess ? 'bg-emerald-500/15 text-emerald-500' : 'bg-amber-500/15 text-amber-500'
            }`}>
              {accountLoading
                ? <RefreshCw size={16} className="animate-spin" />
                : <Clock3 size={16} />}
            </span>
            <div>
              <p className="text-[11px] text-text-secondary">Session access</p>
              <p className="text-sm font-semibold text-text-primary">
                {accountLoading ? 'Verifying access…' : accessLabel(account)}
              </p>
            </div>
          </div>
          <button
            type="button"
            disabled={busy !== null || accountLoading}
            onClick={() => void refreshAccess(true)}
            className="inline-flex items-center gap-1.5 rounded-lg border border-border-subtle px-2.5 py-1.5 text-[11px] font-medium text-text-secondary transition hover:bg-bg-subtle hover:text-text-primary disabled:opacity-50"
          >
            <RefreshCw size={12} className={busy === 'refresh' ? 'animate-spin' : ''} />
            Refresh access
          </button>
        </div>

        {account?.free_session_available && !account.active_session && (
          <p className="mt-2 text-[11px] text-emerald-500">
            This is your one-time free session. It can run for up to 20 minutes.
          </p>
        )}
        {!accountLoading && account && !hasAccess && (
          <p className="mt-2 text-[11px] text-amber-500">
            Your free session has been used. Purchase access before starting another session.
          </p>
        )}
        {account?.active_session && (
          <p className="mt-2 text-[11px] text-text-secondary">
            An existing {account.active_session.surface === 'meeting' ? 'Meeting' : 'Interview Helper'} session
            is active. Finish or resume it before changing products.
          </p>
        )}
      </div>

      <HintilyActiveSessionPanel />

      {notice && (
        <div className={`mt-4 rounded-lg border px-3 py-2 text-xs ${
          notice.kind === 'error'
            ? 'border-red-500/25 bg-red-500/10 text-red-400'
            : notice.kind === 'success'
              ? 'border-emerald-500/25 bg-emerald-500/10 text-emerald-500'
              : 'border-blue-500/25 bg-blue-500/10 text-blue-400'
        }`}>
          {notice.text}
        </div>
      )}

      {hasAccess && !localSessionActive && (
        <HintilyDetailedSessionSetup surface={surface} onStart={onStart} />
      )}

      {hasAccess && localSessionActive && (
        <p className="mt-4 rounded-lg border border-border-subtle bg-bg-primary/30 px-3 py-2 text-xs text-text-secondary">
          This session is already running on this device. Use the launcher&apos;s Resume button
          to return to the live overlay.
        </p>
      )}

      {!accountLoading && account && !hasAccess && (
        <div className="mt-5">
          <div className="mb-3">
            <h3 className="text-sm font-semibold text-text-primary">Choose your Hintily access</h3>
            <p className="mt-0.5 text-[11px] text-text-secondary">
              Payment is applied only after Dodo's verified webhook confirms it.
            </p>
          </div>
          <HintilyPlanGrid compact />
        </div>
      )}
      </div>
    </section>
  );
}
