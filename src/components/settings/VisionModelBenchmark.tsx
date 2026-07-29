import React, { useEffect, useMemo, useReducer } from 'react';
import { AlertTriangle, BarChart3, FileImage, FolderOpen, Play, Square, Upload } from 'lucide-react';

const field = 'w-full rounded-lg border border-border-subtle bg-bg-input px-3 py-2 text-sm text-text-primary outline-none focus:border-accent-primary';
const label = 'mb-1.5 block text-[11px] font-semibold uppercase tracking-[0.08em] text-text-secondary';
const DEFAULTS = {
  measuredRuns: 10, warmupRuns: 2, thinking: 'minimal', resolution: 'high',
  temperature: 0, maxOutputTokens: 4096, execution: 'sequential', connection: 'warm',
  randomizeModelOrder: true, timeoutMs: 120000, interRunDelayMs: 0,
  includeScreenshotInExport: false, promptKind: 'general-vision', mode: 'general',
};

interface BenchmarkState {
  info: any;
  config: any;
  imagePath: string;
  models: string[];
  question: string;
  preview: any;
  session: any;
  current: any;
  running: boolean;
  error: string;
  selectedRunId: string;
  exportPath: string;
}

const INITIAL_STATE: BenchmarkState = {
  info: null,
  config: DEFAULTS,
  imagePath: '',
  models: [],
  question: '',
  preview: null,
  session: null,
  current: null,
  running: false,
  error: '',
  selectedRunId: '',
  exportPath: '',
};

type BenchmarkAction =
  | { type: 'patch'; patch: Partial<BenchmarkState> }
  | { type: 'progress'; payload: any }
  | { type: 'rate-run'; runId: string; ratings: Record<string, number> }
  | { type: 'update-config'; key: string; value: any };

function benchmarkReducer(state: BenchmarkState, action: BenchmarkAction): BenchmarkState {
  if (action.type === 'patch') return { ...state, ...action.patch };
  if (action.type === 'update-config') {
    return { ...state, config: { ...state.config, [action.key]: action.value } };
  }
  if (action.type === 'rate-run') {
    if (!state.session) return state;
    return {
      ...state,
      session: {
        ...state.session,
        runs: state.session.runs.map((run: any) =>
          run.id === action.runId ? { ...run, manualRatings: action.ratings } : run),
      },
    };
  }
  const { payload } = action;
  if (payload.type === 'session') return { ...state, session: { ...payload.session } };
  if (payload.type === 'run-started') return { ...state, current: payload.current };
  if (payload.type === 'run-completed') {
    return {
      ...state,
      session: state.session
        ? {
          ...state.session,
          runs: [...(state.session.runs ?? []).filter((run: any) => run.id !== payload.run.id), payload.run],
        }
        : state.session,
      selectedRunId: state.selectedRunId || payload.run.id,
    };
  }
  return state;
}

function fileUrl(filePath: string): string {
  return `file://${filePath.split('/').map(encodeURIComponent).join('/')}`;
}
function ms(value?: number): string { return value === undefined ? '—' : `${value.toFixed(0)} ms`; }
function bytes(value?: number): string {
  if (value === undefined) return '—';
  return value < 1024 * 1024 ? `${(value / 1024).toFixed(1)} KB` : `${(value / 1024 / 1024).toFixed(2)} MB`;
}

function parseNumericInput(value: string): number | undefined {
  if (value.trim() === '') return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export const VisionModelBenchmark: React.FC = () => {
  const [state, dispatch] = useReducer(benchmarkReducer, INITIAL_STATE);
  const {
    info, config, imagePath, models, question, preview, session, current,
    running, error, selectedRunId, exportPath,
  } = state;
  const patch = (next: Partial<BenchmarkState>) => dispatch({ type: 'patch', patch: next });
  const selectedModels = useMemo(() => new Set(models), [models]);

  useEffect(() => {
    window.electronAPI.visionBenchmarkInfo().then((next) => {
      patch({
        info: next,
        models: next.models.reduce((ids: string[], model: any) => {
        if (model.enabled) ids.push(model.modelId);
        return ids;
        }, []),
        question: next.defaultQuestion,
      });
    }).catch(() => patch({ error: 'The benchmark is disabled. Restart with NATIVELY_ENABLE_BENCHMARKS=true.' }));
    return window.electronAPI.onVisionBenchmarkProgress((payload) => {
      dispatch({ type: 'progress', payload });
    });
  }, []);

  useEffect(() => {
    if (!question) return;
    const timer = setTimeout(() => window.electronAPI.visionBenchmarkPreviewPrompt({
      promptKind: config.promptKind, mode: config.mode, question, imagePath,
    }).then((next) => patch({ preview: next })).catch((e) => patch({ error: String(e?.message || e) })), 150);
    return () => clearTimeout(timer);
  }, [config.promptKind, config.mode, question, imagePath]);

  const selectedRun = session?.runs?.find((run: any) => run.id === selectedRunId) ?? session?.runs?.at(-1);
  const measuredCompleted = session?.runs?.filter((run: any) => !run.warmup).length ?? 0;
  const numericConfigIsValid = [
    config.measuredRuns,
    config.warmupRuns,
    config.temperature,
    config.maxOutputTokens,
    config.timeoutMs,
    config.interRunDelayMs,
  ].every((value) => typeof value === 'number' && Number.isFinite(value));
  const total = numericConfigIsValid
    ? (config.measuredRuns + config.warmupRuns) * Math.max(models.length, 1)
    : 0;
  const update = (key: string, value: any) => dispatch({ type: 'update-config', key, value });

  const chooseImage = async () => {
    const result = await window.electronAPI.visionBenchmarkPickImage();
    if (!result.cancelled && result.path) patch({ imagePath: result.path });
  };
  const acceptDropped = (event: React.DragEvent) => {
    event.preventDefault();
    const dropped = event.dataTransfer.files[0] as File & { path?: string };
    if (dropped?.path && /\.(png|jpe?g|webp)$/i.test(dropped.path)) patch({ imagePath: dropped.path });
    else patch({ error: 'Drop a PNG, JPEG, or WebP file.' });
  };
  const run = async () => {
    if (!numericConfigIsValid) {
      patch({ error: 'Complete every numeric benchmark setting with a valid number.' });
      return;
    }
    patch({ error: '', running: true, session: null, exportPath: '' });
    const result = await window.electronAPI.visionBenchmarkRun({
      ...config, imagePath, modelIds: models, question,
    });
    patch(result.ok
      ? { running: false, session: result.session }
      : { running: false, error: result.error || 'Benchmark failed.' });
  };
  const exportResults = async () => {
    const result = await window.electronAPI.visionBenchmarkExport();
    if (result.ok && result.path) patch({ exportPath: result.path });
    else patch({ error: result.error || 'Export failed.' });
  };

  const fastest = useMemo(() => {
    const stats = session?.statistics ?? [];
    return stats.reduce((best: any, stat: any) =>
      (stat.metrics?.requestTtftMs?.median ?? Infinity) < (best?.metrics?.requestTtftMs?.median ?? Infinity) ? stat : best, null);
  }, [session]);

  if (!info) return <div className="p-6 text-sm text-text-secondary">{error || 'Loading benchmark…'}</div>;

  return (
    <div className="space-y-5 pb-8 animated fadeIn">
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="mb-1 flex items-center gap-2"><BarChart3 size={18} /><h2 className="text-lg font-bold text-text-primary">Vision Model Benchmark</h2></div>
          <p className="max-w-2xl text-xs leading-relaxed text-text-secondary">Compare the same screenshot, prompt, and generation settings across Gemini models. Warm-ups are excluded from statistics.</p>
        </div>
        <span className="rounded-full border border-border-subtle bg-bg-item-surface px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wider text-text-secondary">Developer only</span>
      </div>

      <div className="flex gap-3 rounded-xl border border-amber-500/25 bg-amber-500/5 p-4 text-xs leading-relaxed text-text-secondary">
        <AlertTriangle size={18} className="shrink-0 text-amber-500" />
        <span>This screenshot will be sent to the selected Gemini API endpoint. It may contain confidential information. It will not be sent to Natively analytics or included in reports unless screenshot export is explicitly enabled.</span>
      </div>

      {error && <div className="rounded-lg border border-red-500/30 bg-red-500/5 px-4 py-3 text-xs text-red-500">{error}</div>}

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1.1fr)_minmax(300px,.9fr)]">
        <section className="rounded-xl border border-border-subtle bg-bg-card p-4">
          <h3 className="mb-3 text-sm font-semibold text-text-primary">Screenshot</h3>
          <button type="button" onClick={chooseImage} onDrop={acceptDropped} onDragOver={(e) => e.preventDefault()}
            className="group flex min-h-56 w-full items-center justify-center overflow-hidden rounded-xl border border-dashed border-border-muted bg-bg-input transition-colors hover:border-accent-primary">
            {imagePath ? <img src={fileUrl(imagePath)} alt="Selected screenshot" className="max-h-80 w-full object-contain" /> : (
              <span className="flex flex-col items-center gap-2 text-text-secondary"><FileImage size={28} /><span className="text-sm font-medium">Choose or drop a screenshot</span><span className="text-xs">PNG, JPEG, or WebP</span></span>
            )}
          </button>
          {imagePath && <div className="mt-2 truncate text-[11px] text-text-secondary">{imagePath}</div>}
          {selectedRun?.image && <div className="mt-3 grid grid-cols-2 gap-2 text-xs text-text-secondary">
            <span>Original: {selectedRun.image.originalWidth} × {selectedRun.image.originalHeight}</span><span>{bytes(selectedRun.image.originalBytes)}</span>
            <span>Submitted: {selectedRun.image.submittedWidth} × {selectedRun.image.submittedHeight}</span><span>{bytes(selectedRun.image.submittedBytes)}</span>
          </div>}
        </section>

        <section className="rounded-xl border border-border-subtle bg-bg-card p-4">
          <h3 className="mb-3 text-sm font-semibold text-text-primary">Models</h3>
          <div className="space-y-2">
            {info.models.map((model: any) => <label key={model.modelId} className="flex items-start gap-3 rounded-lg border border-border-subtle bg-bg-input p-3">
              <input type="checkbox" className="mt-0.5 accent-current" checked={selectedModels.has(model.modelId)}
                onChange={(e) => patch({
                  models: e.target.checked
                    ? [...models, model.modelId]
                    : models.filter((id) => id !== model.modelId),
                })} />
              <span className="min-w-0"><span className="block text-sm font-medium text-text-primary">{model.label}</span><span className="block truncate font-mono text-[10px] text-text-secondary">{model.modelId} · {model.source}</span></span>
            </label>)}
          </div>
          {!info.hasCredentials && <p className="mt-3 text-xs text-amber-500">No Gemini credential is currently available.</p>}
        </section>
      </div>

      <section className="rounded-xl border border-border-subtle bg-bg-card p-4">
        <h3 className="mb-4 text-sm font-semibold text-text-primary">Request configuration</h3>
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
          <div><label htmlFor="vision-prompt-kind" className={label}>Prompt</label><select id="vision-prompt-kind" className={field} value={config.promptKind} onChange={(e) => update('promptKind', e.target.value)}>{info.promptOptions.map((o: any) => <option key={o.id} value={o.id}>{o.label}</option>)}</select></div>
          <div><label htmlFor="vision-mode" className={label}>Natively mode</label><select id="vision-mode" className={field} value={config.mode} onChange={(e) => update('mode', e.target.value)}>{info.modeOptions.map((o: string) => <option key={o}>{o}</option>)}</select></div>
          <div><label htmlFor="vision-thinking" className={label}>Thinking</label><select id="vision-thinking" className={field} value={config.thinking} onChange={(e) => update('thinking', e.target.value)}>{['minimal','low','medium','high'].map((o) => <option key={o}>{o}</option>)}</select></div>
          <div><label htmlFor="vision-resolution" className={label}>Resolution</label><select id="vision-resolution" className={field} value={config.resolution} onChange={(e) => update('resolution', e.target.value)}>{['original','high','balanced','fast'].map((o) => <option key={o}>{o}</option>)}</select></div>
          <div><label htmlFor="vision-measured-runs" className={label}>Measured runs</label><input id="vision-measured-runs" className={field} type="number" min={1} max={100} value={config.measuredRuns ?? ''} onChange={(e) => update('measuredRuns', parseNumericInput(e.target.value))} /></div>
          <div><label htmlFor="vision-warmup-runs" className={label}>Warm-up runs</label><input id="vision-warmup-runs" className={field} type="number" min={0} max={20} value={config.warmupRuns ?? ''} onChange={(e) => update('warmupRuns', parseNumericInput(e.target.value))} /></div>
          <div><label htmlFor="vision-temperature" className={label}>Temperature</label><input id="vision-temperature" className={field} type="number" min={0} max={2} step={.1} value={config.temperature ?? ''} onChange={(e) => update('temperature', parseNumericInput(e.target.value))} /></div>
          <div><label htmlFor="vision-max-output" className={label}>Max output tokens</label><input id="vision-max-output" className={field} type="number" min={1} value={config.maxOutputTokens ?? ''} onChange={(e) => update('maxOutputTokens', parseNumericInput(e.target.value))} /></div>
          <div><label htmlFor="vision-execution" className={label}>Execution</label><select id="vision-execution" className={field} value={config.execution} onChange={(e) => update('execution', e.target.value)}><option value="sequential">Sequential</option><option value="parallel">Parallel</option></select></div>
          <div><label htmlFor="vision-connection" className={label}>Connection</label><select id="vision-connection" className={field} value={config.connection} onChange={(e) => update('connection', e.target.value)}><option value="warm">Warm client</option><option value="fresh-client">Fresh client</option></select></div>
          <div><label htmlFor="vision-timeout" className={label}>Timeout (ms)</label><input id="vision-timeout" className={field} type="number" min={1000} value={config.timeoutMs ?? ''} onChange={(e) => update('timeoutMs', parseNumericInput(e.target.value))} /></div>
          <div><label htmlFor="vision-delay" className={label}>Inter-run delay (ms)</label><input id="vision-delay" className={field} type="number" min={0} value={config.interRunDelayMs ?? ''} onChange={(e) => update('interRunDelayMs', parseNumericInput(e.target.value))} /></div>
        </div>
        <div className="mt-4"><label htmlFor="vision-question" className={label}>User question</label><textarea id="vision-question" className={`${field} min-h-24 resize-y`} value={question} onChange={(e) => patch({ question: e.target.value })} /></div>
        <div className="mt-4 flex flex-wrap gap-5 text-xs text-text-secondary">
          <label className="flex items-center gap-2"><input type="checkbox" checked={config.randomizeModelOrder} onChange={(e) => update('randomizeModelOrder', e.target.checked)} /> Randomize model order</label>
          <label className="flex items-center gap-2"><input type="checkbox" checked={config.includeScreenshotInExport} onChange={(e) => update('includeScreenshotInExport', e.target.checked)} /> Include screenshot in export</label>
        </div>
      </section>

      {preview && <section className="rounded-xl border border-border-subtle bg-bg-card p-4">
        <div className="flex flex-wrap gap-x-5 gap-y-1 text-xs text-text-secondary"><b className="text-text-primary">Prompt preview</b><span>{preview.builder}</span><span>{preview.systemPromptCharacters.toLocaleString()} system chars</span><span>{preview.systemPromptTokens ?? 'token count available after request'}</span><span>{preview.userMessageCharacters.toLocaleString()} user chars</span><span>{preview.screenshotAttached ? 'Screenshot attached' : 'No screenshot'}</span></div>
        <div className="mt-2 break-all font-mono text-[10px] text-text-secondary">SHA-256 {preview.promptHash}</div>
        <details className="mt-3"><summary className="cursor-pointer text-xs font-medium text-text-primary">Final system prompt</summary><pre className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap rounded-lg bg-bg-input p-3 text-[11px] text-text-secondary">{preview.systemPrompt}</pre></details>
        <details className="mt-2"><summary className="cursor-pointer text-xs font-medium text-text-primary">Final user message</summary><pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap rounded-lg bg-bg-input p-3 text-[11px] text-text-secondary">{preview.userMessage}</pre></details>
      </section>}

      <div className="flex flex-wrap items-center gap-3">
        <button type="button" disabled={running || !imagePath || !models.length || !numericConfigIsValid} onClick={run} className="flex items-center gap-2 rounded-lg bg-accent-primary px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-40"><Play size={15} /> Run Benchmark</button>
        <button type="button" disabled={!running} onClick={() => window.electronAPI.visionBenchmarkCancel()} className="flex items-center gap-2 rounded-lg border border-border-subtle bg-bg-card px-4 py-2.5 text-sm font-medium text-text-primary disabled:opacity-40"><Square size={14} /> Cancel</button>
        <button type="button" disabled={!session?.runs?.length || running} onClick={exportResults} className="flex items-center gap-2 rounded-lg border border-border-subtle bg-bg-card px-4 py-2.5 text-sm font-medium text-text-primary disabled:opacity-40"><Upload size={15} /> Export Results</button>
        {exportPath && <button type="button" onClick={() => window.electronAPI.visionBenchmarkShowExport(exportPath)} className="flex min-w-0 items-center gap-2 text-xs text-accent-primary"><FolderOpen size={14} /><span className="truncate">{exportPath}</span></button>}
        {running && <span className="text-xs text-text-secondary">{current ? `${current.model.label} · ${current.warmup ? 'warm-up' : 'run'} ${current.runNumber}` : 'Preparing…'} · {session?.runs?.length ?? 0}/{total}</span>}
      </div>

      {session?.statistics?.length > 0 && <section className="overflow-hidden rounded-xl border border-border-subtle bg-bg-card">
        <div className="flex items-center justify-between p-4"><h3 className="text-sm font-semibold text-text-primary">Statistical comparison</h3><span className="text-[10px] text-text-secondary">Balanced: latency 45% · quality 45% · reliability 10%</span></div>
        <div className="overflow-x-auto"><table className="w-full min-w-[1100px] text-left text-xs">
          <thead className="border-y border-border-subtle bg-bg-input text-[10px] uppercase tracking-wider text-text-secondary"><tr>{['Model','Actual model ID','Success','Median TTFT','P75','P95','E2E TTFT','Total latency','Tokens/s','Input tokens','Output tokens','Reasoning','Image bytes','Quality','Balanced'].map((h) => <th key={h} className="px-3 py-2.5">{h}</th>)}</tr></thead>
          <tbody>{session.statistics.map((stat: any) => <tr key={stat.model.modelId} className={`border-b border-border-subtle last:border-0 ${fastest?.model.modelId === stat.model.modelId ? 'bg-accent-subtle' : ''}`}>
            <td className="p-3 font-medium text-text-primary">{stat.model.label}</td><td className="p-3 font-mono text-[10px]">{stat.model.modelId}</td><td className="p-3">{(stat.successRate*100).toFixed(0)}%</td>
            <td className="p-3">{ms(stat.metrics.requestTtftMs.median)}</td><td className="p-3">{ms(stat.metrics.requestTtftMs.p75)}</td><td className="p-3">{ms(stat.metrics.requestTtftMs.p95)}</td>
            <td className="p-3">{ms(stat.metrics.endToEndTtftMs.median)}</td><td className="p-3">{ms(stat.metrics.totalResponseLatencyMs.median)}</td><td className="p-3">{stat.metrics.outputTokensPerSecond.median?.toFixed(1) ?? '—'}</td>
            <td className="p-3">{stat.averageInputTokens?.toFixed(0) ?? '—'}</td><td className="p-3">{stat.averageVisibleOutputTokens?.toFixed(0) ?? '—'}</td><td className="p-3">{stat.averageReasoningTokens?.toFixed(0) ?? '—'}</td>
            <td className="p-3">{bytes(stat.averageSubmittedImageBytes)}</td><td className="p-3">{stat.averageManualQuality?.toFixed(2) ?? '—'}</td><td className="p-3">{stat.balancedScore?.toFixed(3) ?? '—'}</td>
          </tr>)}</tbody>
        </table></div>
      </section>}

      {session?.runs?.length > 0 && <section className="grid gap-4 xl:grid-cols-[240px_minmax(0,1fr)]">
        <div className="rounded-xl border border-border-subtle bg-bg-card p-2"><div className="p-2 text-xs font-semibold text-text-primary">Runs ({measuredCompleted} measured)</div>{session.runs.map((run: any) => <button type="button" key={run.id} onClick={() => patch({ selectedRunId: run.id })} className={`mb-1 w-full rounded-lg p-2 text-left text-xs ${selectedRun?.id === run.id ? 'bg-bg-item-active text-text-primary' : 'text-text-secondary hover:bg-bg-input'}`}><span className="block font-medium">{run.model.label}</span><span>{run.warmup ? 'Warm-up' : 'Run'} {run.runNumber} · {run.success ? ms(run.requestTtftMs) : run.error?.code}</span></button>)}</div>
        {selectedRun && <div className="space-y-3 rounded-xl border border-border-subtle bg-bg-card p-4">
          <div className="grid grid-cols-2 gap-2 text-xs text-text-secondary md:grid-cols-4"><span>Provider {ms(selectedRun.providerEventLatencyMs)}</span><span>Reasoning {ms(selectedRun.reasoningLatencyMs)}</span><span>Request TTFT {ms(selectedRun.requestTtftMs)}</span><span>Total {ms(selectedRun.totalResponseLatencyMs)}</span></div>
          <details open><summary className="cursor-pointer text-xs font-semibold text-text-primary">Raw response</summary><pre className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap rounded-lg bg-bg-input p-3 text-xs text-text-primary">{selectedRun.response || selectedRun.error?.message}</pre></details>
          <details><summary className="cursor-pointer text-xs font-semibold text-text-primary">Reasoning events</summary><pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap rounded-lg bg-bg-input p-3 text-xs text-text-secondary">{selectedRun.reasoning || 'No reasoning delta was exposed.'}</pre></details>
          <details><summary className="cursor-pointer text-xs font-semibold text-text-primary">Sanitized event trace</summary><pre className="mt-2 max-h-64 overflow-auto rounded-lg bg-bg-input p-3 text-[11px] text-text-secondary">{JSON.stringify(selectedRun.trace, null, 2)}</pre></details>
          <div><div className="mb-2 text-xs font-semibold text-text-primary">Manual quality ratings</div><div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">{[['screenshotReadingAccuracy','Screenshot reading'],['visibleTextAccuracy','Visible text'],['taskIdentification','Task identification'],['factualCorrectness','Factual correctness'],['instructionAdherence','Instruction adherence'],['usefulness','Usefulness'],['naturalNativelyStyle','Natively style']].map(([key,title]) => <label key={key} className="text-[11px] text-text-secondary">{title}<select className={`${field} mt-1`} value={selectedRun.manualRatings?.[key] ?? ''} onChange={async (e) => { const ratings = { ...(selectedRun.manualRatings ?? {}), [key]: Number(e.target.value) }; await window.electronAPI.visionBenchmarkRate({ runId: selectedRun.id, ratings }); dispatch({ type: 'rate-run', runId: selectedRun.id, ratings }); }}><option value="">Not rated</option>{[1,2,3,4,5].map((n) => <option key={n} value={n}>{n}</option>)}</select></label>)}</div></div>
        </div>}
      </section>}
    </div>
  );
};
