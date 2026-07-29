import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertCircle,
  CalendarDays,
  CheckCircle2,
  FileText,
  Loader2,
  Mic,
  Play,
  RefreshCw,
  Upload,
  Volume2,
} from 'lucide-react';
import { useHintilyAccount } from '../../lib/hintily/HintilyAccountContext';
import {
  modeMatchesSurface,
  type HintilyCalendarEventSelection,
  type HintilyLauncherStartRequest,
  type HintilyMode,
} from '../../lib/hintily/launcherSession';
import type { HintilyLauncherSurface } from './LauncherSessionSetup';
import { useResolvedTheme } from '../../hooks/useResolvedTheme';

type Device = { id: string; name: string };
type PermissionState = Awaited<ReturnType<typeof window.electronAPI.checkPermissions>>;
type DocumentState = 'missing' | 'ready' | 'processing' | 'error';
type AudioDiagnostic = 'native-unavailable' | 'enumeration-failed' | null;

interface Draft {
  modeId: string;
  company: string;
  role: string;
  title: string;
  context: string;
  participants: string;
  calendarEventId: string;
  inputDeviceId: string;
  outputDeviceId: string;
}

interface Props {
  surface: HintilyLauncherSurface;
  onStart: (request: HintilyLauncherStartRequest) => Promise<{
    success: boolean;
    error?: string;
    code?: string;
  }>;
}

const DRAFT_KEY = 'hintily.launcher.setup.v2';
const EMPTY_DRAFT: Draft = {
  modeId: '',
  company: '',
  role: '',
  title: '',
  context: '',
  participants: '',
  calendarEventId: '',
  inputDeviceId: '',
  outputDeviceId: '',
};

const clean = (value: string, max: number): string =>
  value.replace(/\u0000/g, '').trim().slice(0, max);

const readDraft = (surface: HintilyLauncherSurface): Draft => {
  try {
    const parsed = JSON.parse(localStorage.getItem(DRAFT_KEY) || '{}') as Record<string, unknown>;
    const raw = parsed[surface];
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return EMPTY_DRAFT;
    const value = raw as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(EMPTY_DRAFT).map(key => [
        key,
        typeof value[key] === 'string' ? value[key] : '',
      ]),
    ) as unknown as Draft;
  } catch {
    return EMPTY_DRAFT;
  }
};

const saveDraft = (surface: HintilyLauncherSurface, draft: Draft): void => {
  try {
    const parsed = JSON.parse(localStorage.getItem(DRAFT_KEY) || '{}') as Record<string, unknown>;
    localStorage.setItem(DRAFT_KEY, JSON.stringify({ ...parsed, [surface]: draft }));
  } catch {
    // Draft persistence is a convenience only.
  }
};

const documentError = (error: unknown, fallback: string): string =>
  error instanceof Error && error.message ? error.message : fallback;

const actionableStartError = (value: string): string => {
  const messages: Record<string, string> = {
    signed_out: 'Your Google session expired. Sign in again.',
    no_available_session: 'No session is available. Refresh access or purchase a plan.',
    authorization_failed: 'Hintily could not authorize this session. Refresh access and retry.',
    managed_ai_unavailable: 'Managed AI is temporarily unavailable. No session was consumed; retry shortly.',
    stt_provider_not_ready: 'One or both Deepgram audio channels could not become ready. Check your connection and retry.',
    managed_session_activation_timeout: 'Provider startup timed out. No session was consumed; retry.',
    audio_device_disconnected: 'An audio device disconnected. Refresh devices and select replacements.',
    mic_permission_denied: 'Microphone permission is denied. Allow Hintily in system settings and retry.',
    session_surface_mismatch: 'A session for the other Hintily surface is still active. Refresh access to reconcile it.',
  };
  const normalized = value.trim().toLowerCase().replace(/-/g, '_');
  return messages[normalized] || value;
};

export function HintilyDetailedSessionSetup({ surface, onStart }: Props): React.ReactElement {
  const { signedIn, account, hasAccess, refreshAccess } = useHintilyAccount();
  const isDarkTheme = useResolvedTheme() === 'dark';
  const [draft, setDraft] = useState<Draft>(() => readDraft(surface));
  const [modes, setModes] = useState<HintilyMode[]>([]);
  const [modesLoading, setModesLoading] = useState(true);
  const [devicesLoading, setDevicesLoading] = useState(true);
  const [audioDiagnostic, setAudioDiagnostic] = useState<AudioDiagnostic>(null);
  const [isPackagedApp, setIsPackagedApp] = useState(true);
  const [inputDevices, setInputDevices] = useState<Device[]>([]);
  const [outputDevices, setOutputDevices] = useState<Device[]>([]);
  const [permissions, setPermissions] = useState<PermissionState | null>(null);
  const [permissionsLoading, setPermissionsLoading] = useState(true);
  const [resumeState, setResumeState] = useState<DocumentState>('missing');
  const [jdState, setJdState] = useState<DocumentState>('missing');
  const [documentMessage, setDocumentMessage] = useState('');
  const [jdText, setJdText] = useState('');
  const [calendarEvents, setCalendarEvents] = useState<HintilyCalendarEventSelection[]>([]);
  const [calendarConnected, setCalendarConnected] = useState(false);
  const [starting, setStarting] = useState(false);
  const [testingMic, setTestingMic] = useState(false);
  const [error, setError] = useState('');
  const [readinessError, setReadinessError] = useState('');
  const mountedRef = useRef(true);
  const startRef = useRef(false);
  const resumableSession = account?.active_session?.surface === surface;

  const updateDraft = useCallback((patch: Partial<Draft>): void => {
    setDraft(previous => ({ ...previous, ...patch }));
  }, []);

  useEffect(() => {
    setDraft(readDraft(surface));
    setError('');
  }, [surface]);

  useEffect(() => {
    saveDraft(surface, draft);
  }, [draft, surface]);

  const loadDocuments = useCallback(async (): Promise<void> => {
    try {
      const status = await window.electronAPI.profileGetStatus() as Record<string, unknown>;
      if (!mountedRef.current) return;
      setResumeState(status.resume_structured_extraction_complete || status.hasProfile ? 'ready' : 'missing');
      setJdState(status.jd_structured_extraction_complete || status.jdFactsReady ? 'ready' : 'missing');
    } catch {
      if (!mountedRef.current) return;
      setResumeState('error');
      setJdState('error');
      setDocumentMessage('Could not load document status. Retry before starting.');
    }
  }, []);

  const loadModes = useCallback(async (): Promise<void> => {
    setModesLoading(true);
    try {
      const all = await window.electronAPI.modesEnsureLauncherDefaults();
      if (!mountedRef.current) return;
      setModes(all);
    } catch {
      if (mountedRef.current) setError('Could not load Modes Manager modes.');
    } finally {
      if (mountedRef.current) setModesLoading(false);
    }
  }, []);

  const loadDevicesAndPermissions = useCallback(async (): Promise<void> => {
    setDevicesLoading(true);
    setPermissionsLoading(true);
    try {
      const [deviceResult, permissionsResult] = await Promise.allSettled([
        window.electronAPI.getAudioDeviceStatus(),
        window.electronAPI.checkPermissions(),
      ]);
      if (!mountedRef.current) return;

      const failures: string[] = [];
      if (deviceResult.status === 'fulfilled') {
        const deviceStatus = deviceResult.value;
        const inputs = deviceStatus.inputs;
        const outputs = deviceStatus.outputs;
        setInputDevices(inputs);
        setOutputDevices(outputs);
        setIsPackagedApp(deviceStatus.isPackaged);
        setAudioDiagnostic(
          !deviceStatus.nativeModuleAvailable
            ? 'native-unavailable'
            : (!deviceStatus.inputEnumerationOk || !deviceStatus.outputEnumerationOk)
              ? 'enumeration-failed'
              : null,
        );
        const preferredInput = draft.inputDeviceId
          || localStorage.getItem('preferredInputDeviceId')
          || '';
        const preferredOutput = draft.outputDeviceId
          || localStorage.getItem('preferredOutputDeviceId')
          || '';
        updateDraft({
          inputDeviceId: inputs.some(device => device.id === preferredInput)
            ? preferredInput
            : (inputs[0]?.id || ''),
          outputDeviceId: outputs.some(device => device.id === preferredOutput)
            ? preferredOutput
            : (outputs[0]?.id || ''),
        });
      } else {
        setInputDevices([]);
        setOutputDevices([]);
        setAudioDiagnostic('enumeration-failed');
        failures.push('Audio devices could not be checked. Restart Hintily and refresh devices.');
      }

      if (permissionsResult.status === 'fulfilled') {
        setPermissions(permissionsResult.value);
      } else {
        setPermissions(null);
        failures.push('Audio permissions could not be checked. Open system privacy settings, then restart Hintily.');
      }
      setReadinessError(failures.join(' '));
    } catch {
      // Promise.allSettled itself does not reject; retain a defensive boundary
      // for unexpected renderer/runtime failures.
      if (mountedRef.current) setReadinessError('Audio readiness could not be checked. Restart Hintily and retry.');
    } finally {
      if (mountedRef.current) {
        setDevicesLoading(false);
        setPermissionsLoading(false);
      }
    }
  }, [draft.inputDeviceId, draft.outputDeviceId, updateDraft]);

  const loadCalendar = useCallback(async (): Promise<void> => {
    try {
      const status = await window.electronAPI.getCalendarStatus();
      if (!mountedRef.current) return;
      setCalendarConnected(Boolean(status?.connected));
      if (!status?.connected) {
        setCalendarEvents([]);
        return;
      }
      const events = await window.electronAPI.getUpcomingEvents();
      if (!mountedRef.current) return;
      setCalendarEvents((Array.isArray(events) ? events : []).filter(event =>
        event && typeof event.id === 'string' && typeof event.title === 'string'
          && typeof event.startTime === 'string'));
    } catch {
      if (mountedRef.current) setCalendarEvents([]);
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    void Promise.all([loadDocuments(), loadModes(), loadDevicesAndPermissions(), loadCalendar()]);
    const onDeviceChange = (): void => { void loadDevicesAndPermissions(); };
    navigator.mediaDevices?.addEventListener?.('devicechange', onDeviceChange);
    return () => {
      mountedRef.current = false;
      navigator.mediaDevices?.removeEventListener?.('devicechange', onDeviceChange);
      void window.electronAPI.stopAudioTest().catch(() => undefined);
    };
    // Initial load only; explicit reload actions and devicechange handle refresh.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const availableModes = useMemo(
    () => modes.filter(mode => modeMatchesSurface(mode, surface)),
    [modes, surface],
  );
  const selectedMode = availableModes.find(mode => mode.id === draft.modeId) || null;
  const selectedCalendarEvent = calendarEvents.find(event => event.id === draft.calendarEventId);
  const interviewRequiresJd = selectedMode?.templateType === 'technical-interview';
  const micBlocked = permissions?.microphone === 'denied'
    || permissions?.microphone === 'restricted'
    || permissions?.microphone === 'not-determined';
  const screenBlocked = permissions?.screen === 'denied'
    || permissions?.screen === 'restricted'
    || permissions?.screen === 'not-determined';

  useEffect(() => {
    if (!draft.modeId || !availableModes.some(mode => mode.id === draft.modeId)) {
      updateDraft({ modeId: availableModes[0]?.id || '' });
    }
  }, [availableModes, draft.modeId, updateDraft]);

  const uploadDocument = async (kind: 'resume' | 'jd'): Promise<void> => {
    const setter = kind === 'resume' ? setResumeState : setJdState;
    setter('processing');
    setDocumentMessage('');
    setError('');
    try {
      const selection = await window.electronAPI.profileSelectFile();
      if (selection.cancelled) {
        await loadDocuments();
        return;
      }
      if (!selection.success || !selection.filePath) {
        throw new Error(selection.error || 'The document was not selected.');
      }
      const result = kind === 'resume'
        ? await window.electronAPI.profileUploadResume(selection.filePath)
        : await window.electronAPI.profileUploadJD(selection.filePath);
      if (!result.success) throw new Error(result.error || 'Document processing failed.');
      await loadDocuments();
      setDocumentMessage(`${kind === 'resume' ? 'Resume' : 'Job description'} is ready.`);
    } catch (uploadError) {
      setter('error');
      setDocumentMessage(documentError(uploadError, 'Document processing failed. Re-select the file and retry.'));
    }
  };

  const pasteJobDescription = async (): Promise<void> => {
    const text = clean(jdText, 100_000);
    if (text.length < 50) {
      setDocumentMessage('Paste at least 50 characters of job-description text.');
      return;
    }
    setJdState('processing');
    setDocumentMessage('');
    try {
      const result = await window.electronAPI.profileUploadJDText(text);
      if (!result.success) throw new Error(result.error || 'Job-description processing failed.');
      setJdText('');
      await loadDocuments();
      setDocumentMessage('Pasted job description is ready.');
    } catch (pasteError) {
      setJdState('error');
      setDocumentMessage(documentError(pasteError, 'Job-description processing failed.'));
    }
  };

  const requestPermissions = async (): Promise<void> => {
    setPermissionsLoading(true);
    setError('');
    try {
      await window.electronAPI.requestMicPermission();
      // Refresh both permission and device state through the same path used by
      // the readiness panel so a recovered permission check also clears any
      // stale readiness failure.
      await loadDevicesAndPermissions();
    } catch {
      setError('Microphone permission could not be requested. Open system settings and allow Hintily.');
    } finally {
      setPermissionsLoading(false);
    }
  };

  const toggleMicTest = async (): Promise<void> => {
    if (testingMic) {
      await window.electronAPI.stopAudioTest();
      setTestingMic(false);
      return;
    }
    if (!draft.inputDeviceId) {
      setError('Select a connected microphone before testing.');
      return;
    }
    try {
      const result = await window.electronAPI.startAudioTest(draft.inputDeviceId);
      if (!result.success) throw new Error('Microphone test could not start.');
      setTestingMic(true);
    } catch (testError) {
      setError(documentError(testError, 'Microphone test could not start.'));
    }
  };

  const validate = (readiness?: {
    inputs: Device[];
    outputs: Device[];
    permissions: PermissionState;
    resumeReady: boolean;
    jdReady: boolean;
  }): string | null => {
    const checkedInputs = readiness?.inputs ?? inputDevices;
    const checkedOutputs = readiness?.outputs ?? outputDevices;
    const checkedPermissions = readiness?.permissions ?? permissions;
    const checkedResumeReady = readiness?.resumeReady ?? resumeState === 'ready';
    const checkedJdReady = readiness?.jdReady ?? jdState === 'ready';
    if (!signedIn) return 'Your Google session expired. Sign in again.';
    if (!account || !hasAccess) return 'No verified Hintily session is available.';
    if (!selectedMode) return `Select an available ${surface === 'meeting' ? 'meeting' : 'interview'} mode.`;
    if (!draft.inputDeviceId || !checkedInputs.some(device => device.id === draft.inputDeviceId)) {
      return 'Select a connected microphone.';
    }
    if (!draft.outputDeviceId || !checkedOutputs.some(device => device.id === draft.outputDeviceId)) {
      return 'Select a connected system-audio device.';
    }
    if (checkedPermissions?.microphone !== 'granted') return 'Microphone permission is required.';
    if (checkedPermissions?.screen !== 'granted') return 'Screen/system-audio permission is required.';
    if (surface === 'interview_helper') {
      if (!clean(draft.company, 160)) return 'Company name is required for Interview Helper.';
      if (!clean(draft.role, 160)) return 'Role/title is required for Interview Helper.';
      if (!checkedResumeReady) return 'A fully parsed resume is required.';
      if (interviewRequiresJd && !checkedJdReady) {
        return 'A fully parsed job description is required for Technical Interview mode.';
      }
    } else if (!clean(draft.title, 200)) {
      return 'Meeting title is required.';
    }
    return null;
  };

  const start = async (): Promise<void> => {
    if (startRef.current) return;
    startRef.current = true;
    setStarting(true);
    setError('');
    try {
      await window.electronAPI.stopAudioTest().catch(() => undefined);
      setTestingMic(false);
      // refreshAccess(true) performs the single authoritative OAuth refresh
      // before loading access. Starting a second refresh in parallel is unsafe
      // because Supabase refresh tokens can rotate.
      const [accessOk, freshInputs, freshOutputs, freshPermissions, freshDocuments] = await Promise.all([
        refreshAccess(true),
        window.electronAPI.getInputDevices(),
        window.electronAPI.getOutputDevices(),
        window.electronAPI.checkPermissions(),
        window.electronAPI.profileGetStatus() as Promise<Record<string, unknown>>,
      ]);
      if (!accessOk) throw new Error('Hintily access could not be verified. Refresh and retry.');
      setInputDevices(freshInputs);
      setOutputDevices(freshOutputs);
      setPermissions(freshPermissions);
      // A failed replacement must not silently fall back to the previously
      // active document even though that older document remains safely stored.
      const freshResumeReady = resumeState !== 'error'
        && resumeState !== 'processing'
        && Boolean(freshDocuments.resume_structured_extraction_complete || freshDocuments.hasProfile);
      const freshJdReady = jdState !== 'error'
        && jdState !== 'processing'
        && Boolean(freshDocuments.jd_structured_extraction_complete || freshDocuments.jdFactsReady);
      setResumeState(freshResumeReady ? 'ready' : 'missing');
      setJdState(freshJdReady ? 'ready' : 'missing');

      const validationError = validate({
        inputs: freshInputs,
        outputs: freshOutputs,
        permissions: freshPermissions,
        resumeReady: freshResumeReady,
        jdReady: freshJdReady,
      });
      if (validationError) throw new Error(validationError);
      const modeResult = await window.electronAPI.modesSetActive(selectedMode!.id);
      if (!modeResult.success) throw new Error(modeResult.error || 'The selected mode could not be activated.');

      const request: HintilyLauncherStartRequest = {
        surface,
        modeId: selectedMode!.id,
        modeTemplateType: selectedMode!.templateType,
        title: clean(surface === 'meeting' ? draft.title : `${draft.role} at ${draft.company}`, 200),
        company: clean(draft.company, 160) || undefined,
        role: clean(draft.role, 160) || undefined,
        context: surface === 'meeting' ? clean(draft.context, 4_000) || undefined : undefined,
        participants: surface === 'meeting' ? clean(draft.participants, 2_000) || undefined : undefined,
        calendarEvent: surface === 'meeting' ? selectedCalendarEvent : undefined,
        audio: {
          inputDeviceId: draft.inputDeviceId,
          outputDeviceId: draft.outputDeviceId,
        },
      };
      const result = await onStart(request);
      if (!result.success) {
        throw new Error(actionableStartError(result.code || result.error || 'Hintily could not start.'));
      }
      localStorage.setItem('preferredInputDeviceId', draft.inputDeviceId);
      localStorage.setItem('preferredOutputDeviceId', draft.outputDeviceId);
    } catch (startError) {
      setError(documentError(startError, 'Hintily could not start. Review setup and retry.'));
      await refreshAccess(false).catch(() => false);
    } finally {
      startRef.current = false;
      setStarting(false);
    }
  };

  if (!signedIn || !account) return <></>;

  const fieldClass = `w-full rounded-[14px] border border-border-muted/70 bg-bg-elevated/90 px-4 py-3 text-sm text-text-primary shadow-[0_10px_28px_rgba(0,0,0,0.10),inset_0_1px_0_rgba(255,255,255,0.045)] outline-none transition-all duration-200 placeholder:text-text-tertiary hover:border-emerald-500/25 hover:bg-bg-elevated focus:border-emerald-400/55 focus:ring-4 focus:ring-emerald-500/10 ${
    isDarkTheme ? '[color-scheme:dark]' : '[color-scheme:light]'
  }`;
  const labelClass = 'mb-1.5 block text-[11px] font-semibold text-text-secondary';

  return (
    <div className="mt-5 space-y-4">
      <section className="rounded-2xl border border-border-subtle bg-bg-primary/35 p-5 shadow-[inset_0_1px_0_rgba(255,255,255,0.025)]">
        <div className="mb-4">
          <p className="text-[10px] font-bold uppercase tracking-[0.15em] text-accent-primary">Session details</p>
          <h3 className="mt-1 text-sm font-semibold text-text-primary">Personalize your assistance</h3>
          <p className="mt-1 text-[11px] text-text-tertiary">This context helps Hintily produce relevant, role-specific answers.</p>
        </div>
      <div className="grid gap-4 md:grid-cols-2">
        <div>
          <label className={labelClass}>Mode</label>
          <select
            className={fieldClass}
            value={draft.modeId}
            disabled={modesLoading || Boolean(account.active_session)}
            onChange={event => updateDraft({ modeId: event.target.value })}
          >
            {modesLoading && <option value="">Loading modes…</option>}
            {!modesLoading && availableModes.length === 0 && <option value="">No compatible modes</option>}
            {availableModes.map(mode => (
              <option key={mode.id} value={mode.id}>{mode.name}</option>
            ))}
          </select>
        </div>
        {surface === 'interview_helper' ? (
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className={labelClass}>Company</label>
              <input className={fieldClass} maxLength={160} value={draft.company}
                onChange={event => updateDraft({ company: event.target.value })} />
            </div>
            <div>
              <label className={labelClass}>Role/title</label>
              <input className={fieldClass} maxLength={160} value={draft.role}
                onChange={event => updateDraft({ role: event.target.value })} />
            </div>
          </div>
        ) : (
          <div>
            <label className={labelClass}>Meeting title</label>
            <input className={fieldClass} maxLength={200} value={draft.title}
              onChange={event => updateDraft({ title: event.target.value })} />
          </div>
        )}
      </div>

      {surface === 'interview_helper' ? (
        <div className="mt-4 grid gap-3 md:grid-cols-2">
          <DocumentCard title="Resume" state={resumeState} required onUpload={() => void uploadDocument('resume')} />
          <DocumentCard
            title="Job description"
            state={jdState}
            required={interviewRequiresJd}
            onUpload={() => void uploadDocument('jd')}
          >
            <textarea
              className={`${fieldClass} mt-2 min-h-20 resize-y text-xs`}
              placeholder="Or paste job-description text…"
              maxLength={100_000}
              value={jdText}
              onChange={event => setJdText(event.target.value)}
            />
            <button type="button" disabled={jdState === 'processing'} onClick={() => void pasteJobDescription()}
              className="mt-3 inline-flex items-center rounded-xl border border-border-muted/70 bg-bg-primary/40 px-3 py-2 text-[11px] font-medium text-text-secondary shadow-[inset_0_1px_0_rgba(255,255,255,0.035)] transition hover:border-emerald-500/30 hover:bg-emerald-500/[0.06] hover:text-text-primary disabled:opacity-50">
              Process pasted text
            </button>
          </DocumentCard>
        </div>
      ) : (
        <div className="mt-4 grid gap-4 md:grid-cols-3">
          <div>
            <label className={labelClass}>Company (optional)</label>
            <input className={fieldClass} maxLength={160} value={draft.company}
              onChange={event => updateDraft({ company: event.target.value })} />
          </div>
          <div>
            <label className={labelClass}>Participants (optional)</label>
            <textarea className={`${fieldClass} min-h-20 resize-y`} maxLength={2_000}
              value={draft.participants}
              onChange={event => updateDraft({ participants: event.target.value })} />
          </div>
          <div>
            <label className={labelClass}>Upcoming Calendar event (optional)</label>
            <select className={fieldClass} value={draft.calendarEventId}
              onChange={event => {
                const selected = calendarEvents.find(item => item.id === event.target.value);
                updateDraft({
                  calendarEventId: event.target.value,
                  title: selected?.title || draft.title,
                  participants: selected?.attendees
                    ?.map(attendee => attendee.displayName || attendee.email || '')
                    .filter(Boolean)
                    .join(', ') || draft.participants,
                });
              }}>
              <option value="">{calendarConnected ? 'No Calendar event' : 'Calendar not connected'}</option>
              {calendarEvents.map(event => (
                <option key={event.id} value={event.id}>
                  {event.title} · {new Date(event.startTime).toLocaleString()}
                </option>
              ))}
            </select>
            {!calendarConnected && (
              <p className="mt-1 flex items-center gap-1 text-[10px] text-text-tertiary">
                <CalendarDays size={11} /> Calendar is optional and can be connected in Settings.
              </p>
            )}
          </div>
        </div>
      )}

      {surface === 'meeting' && (
        <div className="mt-4">
          <label className={labelClass}>Meeting purpose/context (optional)</label>
          <textarea className={`${fieldClass} min-h-24 resize-y`} maxLength={4_000}
            value={draft.context}
            onChange={event => updateDraft({ context: event.target.value })} />
        </div>
      )}
      </section>

      <section className="rounded-2xl border border-border-subtle bg-bg-primary/35 p-5 shadow-[inset_0_1px_0_rgba(255,255,255,0.025)]">
        <div className="mb-3 flex items-center justify-between">
          <div>
            <p className="text-[10px] font-bold uppercase tracking-[0.15em] text-accent-primary">Device check</p>
            <h3 className="mt-1 text-sm font-semibold text-text-primary">Audio readiness</h3>
            <p className="mt-1 text-[10px] text-text-tertiary">Tests and permission checks do not consume a session.</p>
          </div>
          <button type="button" onClick={() => void loadDevicesAndPermissions()}
            disabled={devicesLoading || permissionsLoading}
            className="rounded-lg p-2 text-text-secondary hover:bg-bg-subtle disabled:opacity-50"
            aria-label="Refresh audio devices">
            <RefreshCw size={14} className={devicesLoading ? 'animate-spin' : ''} />
          </button>
        </div>
        <div className="grid gap-3 md:grid-cols-2">
          <div className="rounded-[16px] border border-border-muted/60 bg-bg-elevated/65 p-4 shadow-[0_10px_28px_rgba(0,0,0,0.08),inset_0_1px_0_rgba(255,255,255,0.035)]">
            <label className={labelClass}><Mic size={11} className="mr-1 inline" />Microphone</label>
            <select className={fieldClass} value={draft.inputDeviceId}
              onChange={event => updateDraft({ inputDeviceId: event.target.value })}>
              {inputDevices.length === 0 && <option value="">No microphone found</option>}
              {inputDevices.map(device => <option key={device.id} value={device.id}>{device.name}</option>)}
            </select>
          </div>
          <div className="rounded-[16px] border border-border-muted/60 bg-bg-elevated/65 p-4 shadow-[0_10px_28px_rgba(0,0,0,0.08),inset_0_1px_0_rgba(255,255,255,0.035)]">
            <label className={labelClass}><Volume2 size={11} className="mr-1 inline" />System audio/output</label>
            <select className={fieldClass} value={draft.outputDeviceId}
              onChange={event => updateDraft({ outputDeviceId: event.target.value })}>
              {outputDevices.length === 0 && <option value="">No output device found</option>}
              {outputDevices.map(device => <option key={device.id} value={device.id}>{device.name}</option>)}
            </select>
          </div>
        </div>
        {audioDiagnostic && !devicesLoading && (
          <div role="alert" className="mt-3 flex items-start gap-2 rounded-xl border border-amber-500/25 bg-amber-500/[0.07] px-3.5 py-3 text-[11px] leading-relaxed text-amber-400">
            <AlertCircle size={14} className="mt-0.5 shrink-0" />
            <span>
              {audioDiagnostic === 'native-unavailable'
                ? isPackagedApp
                  ? 'Hintily could not load its audio component. Restart Hintily; if this continues, reinstall the latest release or contact support.'
                  : <>Hintily&apos;s native audio module is unavailable. Run <code className="font-mono text-amber-300">npm run ensure:native-audio</code>, restart Hintily, then refresh devices.</>
                : 'Hintily loaded its audio component but could not read one or more device lists. Reconnect the devices, restart Hintily, and refresh.'}
            </span>
          </div>
        )}
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button type="button" onClick={() => void toggleMicTest()}
            disabled={!draft.inputDeviceId || devicesLoading}
            className="rounded-xl border border-border-muted/70 bg-bg-elevated/70 px-3.5 py-2 text-[11px] font-medium text-text-primary shadow-[inset_0_1px_0_rgba(255,255,255,0.035)] transition hover:border-emerald-500/30 hover:bg-emerald-500/[0.06] disabled:opacity-50">
            {testingMic ? 'Stop microphone test' : 'Test microphone'}
          </button>
          {(micBlocked || screenBlocked) && (
            <>
              <button type="button" onClick={() => void requestPermissions()}
                disabled={permissionsLoading}
                className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-1.5 text-[11px] text-amber-400 disabled:opacity-50">
                Review permissions
              </button>
              <span className="text-[10px] text-amber-400">
                {permissions?.platform === 'darwin'
                  ? 'Allow Microphone and Screen Recording in System Settings → Privacy & Security, then restart Hintily.'
                  : 'Allow microphone and screen capture in your operating-system privacy settings, then refresh.'}
              </span>
            </>
          )}
          {!micBlocked && !screenBlocked && permissions && (
            <span className="inline-flex items-center gap-1 text-[11px] text-emerald-500">
              <CheckCircle2 size={12} /> Permissions ready
            </span>
          )}
        </div>
      </section>

      {documentMessage && (
        <p className={`text-xs ${resumeState === 'error' || jdState === 'error' ? 'text-red-400' : 'text-emerald-500'}`}>
          {documentMessage}
        </p>
      )}
      {error && (
        <div role="alert" className="flex items-start gap-2 rounded-lg border border-red-500/25 bg-red-500/10 p-3 text-xs text-red-400">
          <AlertCircle size={14} className="mt-0.5 shrink-0" /> {error}
        </div>
      )}
      {readinessError && (
        <div role="alert" className="flex items-start gap-2 rounded-lg border border-red-500/25 bg-red-500/10 p-3 text-xs text-red-400">
          <AlertCircle size={14} className="mt-0.5 shrink-0" /> {readinessError}
        </div>
      )}

      <button
        type="button"
        disabled={starting || !hasAccess || (Boolean(account.active_session) && !resumableSession)}
        onClick={() => void start()}
        className="inline-flex w-full items-center justify-center gap-2 rounded-xl border border-sky-300/30 bg-gradient-to-b from-sky-400 via-sky-500 to-blue-600 px-5 py-3.5 text-sm font-semibold text-white shadow-[0_10px_30px_rgba(14,165,233,0.3),inset_0_1px_0_rgba(255,255,255,0.3)] transition hover:-translate-y-0.5 hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:translate-y-0"
      >
        {starting ? <Loader2 size={16} className="animate-spin" /> : <Play size={16} />}
        {starting
          ? resumableSession ? 'Reconnecting providers securely…' : 'Starting providers securely…'
          : `${resumableSession ? 'Resume' : 'Start'} ${surface === 'meeting' ? 'Meeting' : 'Interview Helper'}`}
      </button>
    </div>
  );
}

function DocumentCard({
  title,
  state,
  required,
  onUpload,
  children,
}: {
  title: string;
  state: DocumentState;
  required: boolean;
  onUpload: () => void;
  children?: React.ReactNode;
}): React.ReactElement {
  return (
    <div className={`rounded-[16px] border p-4 shadow-[0_10px_28px_rgba(0,0,0,0.08),inset_0_1px_0_rgba(255,255,255,0.035)] transition-all duration-200 ${
      state === 'ready'
        ? 'border-emerald-500/25 bg-emerald-500/[0.045]'
        : state === 'error'
          ? 'border-red-500/25 bg-red-500/[0.045]'
          : 'border-border-muted/60 bg-bg-elevated/65 hover:border-emerald-500/20'
    }`}>
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-2">
          <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-accent-primary/10 text-accent-primary">
            <FileText size={15} />
          </span>
          <div>
            <p className="text-xs font-semibold text-text-primary">{title}</p>
            <p className="text-[10px] text-text-tertiary">{required ? 'Required' : 'Optional'} · {
              state === 'processing' ? 'Parsing and indexing…'
                : state === 'ready' ? 'Ready'
                  : state === 'error' ? 'Needs attention'
                    : 'Not provided'
            }</p>
          </div>
        </div>
        <button type="button" disabled={state === 'processing'} onClick={onUpload}
          className="inline-flex items-center gap-1.5 rounded-xl border border-border-muted/70 bg-bg-primary/40 px-3 py-2 text-[11px] font-medium text-text-secondary shadow-[inset_0_1px_0_rgba(255,255,255,0.035)] transition hover:border-emerald-500/30 hover:bg-emerald-500/[0.06] hover:text-text-primary disabled:opacity-50">
          {state === 'processing'
            ? <Loader2 size={12} className="animate-spin" />
            : <Upload size={12} />}
          {state === 'ready' ? 'Replace' : 'Upload'}
        </button>
      </div>
      {children}
    </div>
  );
}
