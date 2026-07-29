import React, { useState, useEffect, useCallback, useRef, useReducer, useId } from 'react';
import { useT } from '../i18n';
import { Download, Trash2, HardDrive, Check, Loader2, Zap, AlertCircle, ChevronDown, X } from 'lucide-react';
import { AnimatePresence, LazyMotion, domAnimation, m } from 'framer-motion';
import { isMac } from '../utils/platformUtils';

interface ModelInfo {
    id: string;
    name: string;
    sizeMb: number;
    speed: 'very-fast' | 'fast' | 'medium' | 'slow';
    accuracy: 'decent' | 'good' | 'high' | 'very-high';
    multilingual: boolean;
    // 'downloading'  — bytes arriving from the network
    // 'available'    — files verified on disk; ready to use
    // 'missing'      — not on disk
    // 'error'        — last attempt failed (network, disk, dtype mismatch)
    // 'cancelled'    — user explicitly cancelled; partial bytes cleared
    // 'interrupted'  — process quit mid-download; service rehydrated state
    status: 'available' | 'missing' | 'downloading' | 'error' | 'cancelled' | 'interrupted';
    errorMessage?: string;
    requiresAppleSilicon?: boolean;
}

interface HardwareInfo {
    arch: string;
    platform: string;
    isAppleSilicon: boolean;
    totalRamGb: number;
    tier: 'excellent' | 'good' | 'limited';
    recommendation: string;
    recommendedModel: string;
}

interface ChannelConfig {
    enabled: boolean;
    micModelId: string;
    systemModelId: string;
    globalModelId: string;
}

interface RecoveryNotice {
    recovered: true;
    badModelId: string;
    fallbackModelId: string;
    message: string;
}

interface OnnxRecoveryNotice {
    family: 'whisper' | 'intent' | 'embeddings' | 'reranker';
    badModelId: string;
    message: string;
}

interface LocalWhisperPanelState {
    models: ModelInfo[];
    hardware: HardwareInfo | null;
    config: ChannelConfig;
    downloadProgress: Record<string, number>;
    downloadingSet: Set<string>;
    recoveryNotice: RecoveryNotice | null;
    onnxNotices: Partial<Record<OnnxRecoveryNotice['family'], OnnxRecoveryNotice>>;
    loading: boolean;
}

type StateUpdater<T> = T | ((previous: T) => T);
type LocalWhisperPanelFieldAction = {
    [Key in keyof LocalWhisperPanelState]: {
        type: 'field';
        key: Key;
        value: StateUpdater<LocalWhisperPanelState[Key]>;
    }
}[keyof LocalWhisperPanelState];
type LocalWhisperPanelAction =
    | LocalWhisperPanelFieldAction
    | { type: 'update'; update: (state: LocalWhisperPanelState) => LocalWhisperPanelState };

const INITIAL_PANEL_STATE: LocalWhisperPanelState = {
    models: [],
    hardware: null,
    config: {
        enabled: false,
        micModelId: '',
        systemModelId: '',
        globalModelId: '',
    },
    downloadProgress: {},
    downloadingSet: new Set(),
    recoveryNotice: null,
    onnxNotices: {},
    loading: true,
};

function localWhisperPanelReducer(
    state: LocalWhisperPanelState,
    action: LocalWhisperPanelAction,
): LocalWhisperPanelState {
    if (action.type === 'update') return action.update(state);
    const previous = state[action.key];
    const next = typeof action.value === 'function'
        ? (action.value as (value: typeof previous) => typeof previous)(previous)
        : action.value;
    return { ...state, [action.key]: next };
}

const electronAPI = (window as any).electronAPI;

function PremiumSelect({ label, value, options, onChange, placeholder }: any) {
    const t = useT();
    const controlId = useId();
    const [isOpen, setIsOpen] = useState(false);
    const containerRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        const handleClickOutside = (event: MouseEvent) => {
            if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
                setIsOpen(false);
            }
        };
        document.addEventListener('mousedown', handleClickOutside);
        return () => document.removeEventListener('mousedown', handleClickOutside);
    }, []);

    const selectedLabel = options.find((o: any) => o.id === value)?.name || placeholder;

    return (
        <div ref={containerRef} className="relative z-20">
            {label && <label htmlFor={controlId} className="block text-xs font-medium text-text-secondary mb-1.5 uppercase tracking-wide">{label}</label>}
            <button
                id={controlId}
                type="button"
                onClick={() => setIsOpen(!isOpen)}
                className={`w-full group bg-bg-input border border-border-subtle hover:border-border-muted shadow-sm rounded-xl px-3.5 py-2.5 flex items-center justify-between transition-[background-color,border-color,box-shadow] duration-300 ease-[cubic-bezier(0.23,1,0.32,1)] outline-none focus:ring-2 focus:ring-accent-focus ${isOpen ? 'ring-2 ring-accent-focus border-accent-focus' : ''}`}
            >
                <span className="text-sm text-text-primary font-medium truncate pr-4">{selectedLabel}</span>
                <ChevronDown size={14} className={`text-text-tertiary transition-transform duration-300 ease-[cubic-bezier(0.23,1,0.32,1)] group-hover:text-text-secondary ${isOpen ? 'rotate-180' : ''}`} />
            </button>

            <AnimatePresence>
                {isOpen && (
                    <m.div
                        initial={{ opacity: 0, y: 4, scale: 0.98 }}
                        animate={{ opacity: 1, y: 0, scale: 1 }}
                        exit={{ opacity: 0, y: 4, scale: 0.98 }}
                        transition={{ duration: 0.15, ease: "easeOut" }}
                        className="absolute top-full left-0 w-full mt-2 bg-bg-elevated border border-border-subtle rounded-xl shadow-xl z-50 overflow-hidden ring-1 ring-black/5"
                    >
                        <div className="max-h-[240px] overflow-y-auto p-1.5 space-y-0.5 custom-scrollbar">
                            {options.map((option: any) => {
                                const isSelected = value === option.id;
                                return (
                                    <button
                                        type="button"
                                        key={option.id}
                                        onClick={() => { onChange(option.id); setIsOpen(false); }}
                                        className={`w-full rounded-[10px] px-3 py-2.5 flex items-center justify-between transition-[background-color,color,box-shadow] duration-200 group relative ${isSelected ? 'bg-bg-item-active text-text-primary shadow-inner' : 'hover:bg-bg-item-surface text-text-secondary hover:text-text-primary'}`}
                                    >
                                        <span className="text-sm font-medium">{option.name}</span>
                                        {isSelected && <m.div initial={{ scale: 0.95, opacity: 0 }} animate={{ scale: 1, opacity: 1 }}><Check size={16} className="text-accent-primary" strokeWidth={3} /></m.div>}
                                    </button>
                                );
                            })}
                            {options.length === 0 && (
                                <div className="px-3 py-2.5 text-sm text-text-tertiary italic text-center">{t('No models available')}</div>
                            )}
                        </div>
                    </m.div>
                )}
            </AnimatePresence>
        </div>
    );
}

function useLocalWhisperModelPanel() {
    const t = useT();
    const [panelState, dispatch] = useReducer(localWhisperPanelReducer, INITIAL_PANEL_STATE);
    const {
        models,
        hardware,
        config,
        downloadProgress,
        downloadingSet,
        recoveryNotice,
        onnxNotices,
        loading,
    } = panelState;
    const setPanelValue = useCallback(<Key extends keyof LocalWhisperPanelState>(
        key: Key,
        value: StateUpdater<LocalWhisperPanelState[Key]>,
    ) => {
        dispatch({ type: 'field', key, value } as LocalWhisperPanelFieldAction);
    }, []);
    const updatePanel = useCallback(
        (update: (state: LocalWhisperPanelState) => LocalWhisperPanelState) =>
            dispatch({ type: 'update', update }),
        [],
    );
    const setModels = useCallback((value: StateUpdater<ModelInfo[]>) => setPanelValue('models', value), [setPanelValue]);
    const setConfig = useCallback((value: StateUpdater<ChannelConfig>) => setPanelValue('config', value), [setPanelValue]);
    const setDownloadProgress = useCallback((value: StateUpdater<Record<string, number>>) => setPanelValue('downloadProgress', value), [setPanelValue]);
    const setDownloadingSet = useCallback((value: StateUpdater<Set<string>>) => setPanelValue('downloadingSet', value), [setPanelValue]);
    const setRecoveryNotice = useCallback((value: StateUpdater<RecoveryNotice | null>) => setPanelValue('recoveryNotice', value), [setPanelValue]);
    const setOnnxNotices = useCallback((value: StateUpdater<Partial<Record<OnnxRecoveryNotice['family'], OnnxRecoveryNotice>>>) => setPanelValue('onnxNotices', value), [setPanelValue]);

    const loadData = useCallback(async () => {
        try {
            const [modelsRes, hwRes, cfgRes, stateRes, noticeRes, intentRes, embedRes, rerankRes] = await Promise.all([
                electronAPI?.localWhisperGetModels?.(),
                electronAPI?.localWhisperGetHardware?.(),
                electronAPI?.localWhisperGetChannelConfig?.(),
                // NEW (2026-06-23): read the service's live download state so
                // a re-mounted panel sees an in-flight download that started
                // before the overlay was closed. Without this the panel
                // would show 0% / "Install" even though the main process is
                // still downloading.
                electronAPI?.localWhisperGetDownloadState?.().catch(() => []),
                electronAPI?.localWhisperGetRecoveryNotice?.().catch(() => null),
                // Generalized ONNX load-sentinel notices for the other three
                // local-model families (intent classifier / local embeddings /
                // local reranker). Each is one-shot drained through AppState so
                // a renderer reload does not see the same notice twice.
                electronAPI?.onnxGetRecoveryNotice?.('intent').catch(() => null),
                electronAPI?.onnxGetRecoveryNotice?.('embeddings').catch(() => null),
                electronAPI?.onnxGetRecoveryNotice?.('reranker').catch(() => null),
            ]);

            // Merge the three family-keyed notices into a single keyed object
            // so the chips render in a deterministic order. A `null` from the
            // IPC means "no notice this session" — leave the chip out.
            const nextOnnx: LocalWhisperPanelState['onnxNotices'] = {};
            if (intentRes) nextOnnx.intent = intentRes as OnnxRecoveryNotice;
            if (embedRes) nextOnnx.embeddings = embedRes as OnnxRecoveryNotice;
            if (rerankRes) nextOnnx.reranker = rerankRes as OnnxRecoveryNotice;

            // Merge service state into UI state. We only mutate state for
            // entries the service knows about — a 'complete' entry triggers
            // a fresh `getModels` so the badge flips to "available" from
            // the actual filesystem check.
            const nextProgress: Record<string, number> = {};
            const nextDownloading = new Set<string>();
            const interruptedIds = new Set<string>();
            const cancelledIds = new Set<string>();
            const errorIds = new Set<string>();
            if (Array.isArray(stateRes)) {
                for (const s of stateRes) {
                    if (!s || !s.modelId) continue;
                    if (s.status === 'downloading' || s.status === 'verifying') {
                        nextDownloading.add(s.modelId);
                        nextProgress[s.modelId] = typeof s.progress === 'number' ? s.progress : 0;
                    } else if (s.status === 'interrupted') {
                        interruptedIds.add(s.modelId);
                    } else if (s.status === 'cancelled') {
                        cancelledIds.add(s.modelId);
                    } else if (s.status === 'error') {
                        errorIds.add(s.modelId);
                    }
                    // 'complete' — handled below by re-fetching models so
                    // the disk-verified badge is shown.
                }
            }

            // Auto-select initial models if none are set
            let nextConfig = cfgRes as ChannelConfig | undefined;
            if (cfgRes && modelsRes && modelsRes.models) {
                const list = modelsRes.models;
                const avail = list.filter((m: any) => m.status === 'available');
                if (avail.length > 0) {
                    let needsUpdate = false;
                    const newCfg = { ...cfgRes };

                    if (!cfgRes.globalModelId) {
                        newCfg.globalModelId = avail[0].id;
                        electronAPI?.localWhisperSetModel?.(avail[0].id);
                        needsUpdate = true;
                    }
                    if (!cfgRes.micModelId) {
                        newCfg.micModelId = avail[0].id;
                        needsUpdate = true;
                    }
                    if (!cfgRes.systemModelId) {
                        newCfg.systemModelId = avail[0].id;
                        needsUpdate = true;
                    }

                    if (needsUpdate) {
                        nextConfig = newCfg;
                        electronAPI?.localWhisperSetChannelConfig?.(newCfg);
                    }
                }
            }
            updatePanel((previous) => {
                const baseModels: ModelInfo[] = modelsRes?.models ?? previous.models;
                const nextModels = baseModels.map((model) => {
                    if (interruptedIds.has(model.id)) return { ...model, status: 'interrupted' as const };
                    if (cancelledIds.has(model.id)) return { ...model, status: 'cancelled' as const };
                    if (errorIds.has(model.id)) {
                        return { ...model, status: 'error' as const, errorMessage: 'Download was interrupted.' };
                    }
                    return model;
                });
                return {
                    ...previous,
                    models: nextModels,
                    hardware: hwRes ?? previous.hardware,
                    config: nextConfig ?? previous.config,
                    downloadProgress: { ...previous.downloadProgress, ...nextProgress },
                    downloadingSet: nextDownloading,
                    recoveryNotice: noticeRes?.recovered ? noticeRes : previous.recoveryNotice,
                    onnxNotices: nextOnnx,
                    loading: false,
                };
            });
        } finally {
            updatePanel((previous) => previous.loading ? { ...previous, loading: false } : previous);
        }
    }, [updatePanel]);

    useEffect(() => {
        loadData();
    }, [loadData]);

    // Handle downloads
    useEffect(() => {
        const unsubProgress = electronAPI?.onLocalWhisperDownloadProgress?.((data: { modelId: string; progress: number }) => {
            updatePanel((previous) => ({
                ...previous,
                downloadProgress: { ...previous.downloadProgress, [data.modelId]: data.progress },
            }));
        });
        const unsubComplete = electronAPI?.onLocalWhisperDownloadComplete?.((data: { modelId: string }) => {
            updatePanel((previous) => {
                const downloading = new Set(previous.downloadingSet);
                downloading.delete(data.modelId);
                const progress = { ...previous.downloadProgress };
                delete progress[data.modelId];
                return { ...previous, downloadingSet: downloading, downloadProgress: progress };
            });
            loadData();
        });
        const unsubError = electronAPI?.onLocalWhisperDownloadError?.((data: { modelId: string; error: string }) => {
            updatePanel((previous) => {
                const downloading = new Set(previous.downloadingSet);
                downloading.delete(data.modelId);
                const progress = { ...previous.downloadProgress };
                delete progress[data.modelId];
                return {
                    ...previous,
                    downloadingSet: downloading,
                    downloadProgress: progress,
                    models: previous.models.map((model) => model.id === data.modelId
                        ? { ...model, status: 'error', errorMessage: data.error }
                        : model),
                };
            });
        });
        
        return () => { unsubProgress?.(); unsubComplete?.(); unsubError?.(); };
    }, [loadData, updatePanel]);

    const handleDownload = async (modelId: string) => {
        if (downloadingSet.has(modelId)) return;
        setDownloadingSet(prev => new Set([...prev, modelId]));
        setModels(prev => prev.map(m => m.id === modelId ? { ...m, status: 'downloading' } : m));
        setDownloadProgress(prev => ({ ...prev, [modelId]: 0 }));

        const result = await electronAPI?.localWhisperStartDownload?.(modelId);
        if (!result?.success && result?.error !== 'already-downloading') {
            setDownloadingSet(prev => { const s = new Set(prev); s.delete(modelId); return s; });
            setDownloadProgress(prev => { const d = { ...prev }; delete d[modelId]; return d; });
            setModels(prev => prev.map(m => m.id === modelId
                ? { ...m, status: 'error', errorMessage: result?.error ?? 'Download failed' }
                : m
            ));
        }
    };

    // NEW (2026-06-23): explicit user cancel. Stops the worker, clears
    // partial bytes (the service calls provider.deletePartial on next
    // start), and flips the badge so the user can re-install.
    const handleCancel = async (modelId: string) => {
        await electronAPI?.localWhisperCancelDownload?.(modelId);
        // The service broadcasts 'cancelled' → onLocalWhisperDownloadError
        // does NOT fire on cancel, but the next state event arrives via
        // the loadData() rehydration on remount OR the next IPC. To keep
        // the UI responsive immediately, optimistically clear local state.
        setDownloadingSet(prev => { const s = new Set(prev); s.delete(modelId); return s; });
        setDownloadProgress(prev => { const d = { ...prev }; delete d[modelId]; return d; });
        setModels(prev => prev.map(m => m.id === modelId
            ? { ...m, status: 'cancelled' as const, errorMessage: undefined }
            : m
        ));
        // Re-fetch so the disk-truth badge (probably "missing" after
        // deletePartial) is shown.
        await loadData();
    };

    const handleDelete = async (modelId: string) => {
        await electronAPI?.localWhisperDeleteModel?.(modelId);
        await loadData();
    };

    const toggleDualChannel = async (enabled: boolean) => {
        const newCfg = { ...config, enabled };
        setConfig(newCfg);
        await electronAPI?.localWhisperSetChannelConfig?.({ enabled });
    };

    const setGlobalModel = async (modelId: string) => {
        setConfig(prev => ({ ...prev, globalModelId: modelId }));
        await electronAPI?.localWhisperSetModel?.(modelId);
    };

    const setMicModel = async (modelId: string) => {
        setConfig(prev => ({ ...prev, micModelId: modelId }));
        await electronAPI?.localWhisperSetChannelConfig?.({ micModelId: modelId });
    };

    const setSystemModel = async (modelId: string) => {
        setConfig(prev => ({ ...prev, systemModelId: modelId }));
        await electronAPI?.localWhisperSetChannelConfig?.({ systemModelId: modelId });
    };

    return {
        t,
        models,
        hardware,
        config,
        downloadProgress,
        downloadingSet,
        recoveryNotice,
        onnxNotices,
        loading,
        setRecoveryNotice,
        setOnnxNotices,
        handleDownload,
        handleCancel,
        handleDelete,
        toggleDualChannel,
        setGlobalModel,
        setMicModel,
        setSystemModel,
    };
}

export function LocalWhisperModelPanel() {
    const {
        t,
        models,
        hardware,
        config,
        downloadProgress,
        downloadingSet,
        recoveryNotice,
        onnxNotices,
        loading,
        setRecoveryNotice,
        setOnnxNotices,
        handleDownload,
        handleCancel,
        handleDelete,
        toggleDualChannel,
        setGlobalModel,
        setMicModel,
        setSystemModel,
    } = useLocalWhisperModelPanel();

    if (loading) {
        return <div className="p-4 flex justify-center text-text-tertiary"><Loader2 className="animate-spin size-5" /></div>;
    }

    const availableModels = models.filter(m => m.status === 'available');
    
    return (
        <LazyMotion features={domAnimation}>
        <div className="space-y-4">
            {recoveryNotice && (
                <div className="bg-amber-500/10 border border-amber-500/20 rounded-xl p-4 flex items-start gap-3 text-amber-700 dark:text-amber-300">
                    <AlertCircle size={18} className="mt-0.5 flex-shrink-0" />
                    <div className="flex-1 min-w-0">
                        <div className="text-sm font-semibold text-text-primary">{t('Recovered local transcription')}</div>
                        <p className="text-xs text-text-secondary mt-1 leading-relaxed">
                            {t('Hintily recovered from a local transcription model crash. We reset')} <span className="font-mono text-text-primary">{recoveryNotice.badModelId}</span> {t('to')} <span className="font-mono text-text-primary">{recoveryNotice.fallbackModelId}</span> {t('so the app can start safely.')}
                        </p>
                    </div>
                    <button
                        type="button"
                        onClick={() => setRecoveryNotice(null)}
                        className="p-1 rounded-md text-text-tertiary hover:text-text-primary hover:bg-bg-elevated transition-colors"
                        aria-label={t("Dismiss recovery notice")}
                    >
                        <X size={14} />
                    </button>
                </div>
            )}
            {onnxNotices.intent && (
                <OnnxRecoveryChip
                    title={t("Recovered intent classifier")}
                    family="intent"
                    notice={onnxNotices.intent}
                    onDismiss={() => setOnnxNotices((s) => ({ ...s, intent: undefined }))}
                />
            )}
            {onnxNotices.embeddings && (
                <OnnxRecoveryChip
                    title={t("Recovered local embeddings")}
                    family="embeddings"
                    notice={onnxNotices.embeddings}
                    onDismiss={() => setOnnxNotices((s) => ({ ...s, embeddings: undefined }))}
                />
            )}
            {onnxNotices.reranker && (
                <OnnxRecoveryChip
                    title={t("Recovered local reranker")}
                    family="reranker"
                    notice={onnxNotices.reranker}
                    onDismiss={() => setOnnxNotices((s) => ({ ...s, reranker: undefined }))}
                />
            )}
            <div className="bg-bg-card rounded-xl border border-border-subtle p-5 shadow-sm">
                <div className="mb-5">
                    <h3 className="text-sm font-semibold text-text-primary">{t('Local Engine Configuration')}</h3>
                    <p className="text-xs text-text-secondary mt-1 leading-relaxed">{t('Select the AI models you want to use for Speech-to-Text inference.')}</p>
                </div>

                <label className="flex items-center justify-between p-3.5 rounded-xl border border-border-subtle bg-bg-elevated/30 hover:bg-bg-elevated transition-[background-color,border-color,transform] duration-300 ease-[cubic-bezier(0.23,1,0.32,1)] cursor-pointer group mb-5 active:scale-[0.99]">
                    <input 
                        type="checkbox" 
                        className="hidden" 
                        checked={config.enabled} 
                        onChange={(e) => toggleDualChannel(e.target.checked)} 
                    />
                    <div>
                        <span className="text-sm font-medium text-text-primary block transition-colors group-hover:text-accent-primary">{t('Split Audio Channels')}</span>
                        <span className="text-xs text-text-tertiary mt-0.5 block">{t('Use different models for microphone and system audio')}</span>
                    </div>
                    <div className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-300 ease-[cubic-bezier(0.23,1,0.32,1)] focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-primary focus-visible:ring-opacity-75 ${config.enabled ? 'bg-accent-primary' : 'bg-border-muted'}`}>
                        <span className={`pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow ring-0 transition duration-300 ease-[cubic-bezier(0.23,1,0.32,1)] ${config.enabled ? 'translate-x-4' : 'translate-x-0'}`} />
                    </div>
                </label>

                <div className="space-y-4 relative z-10">
                    <AnimatePresence mode="wait">
                        {config.enabled ? (
                            <m.div
                                key="split"
                                initial={{ opacity: 0, y: -10 }}
                                animate={{ opacity: 1, y: 0 }}
                                exit={{ opacity: 0, y: -10 }}
                                transition={{ duration: 0.2, ease: "easeOut" }}
                                className="grid grid-cols-2 gap-4"
                            >
                                <PremiumSelect
                                    label={t("Mic Audio Model")}
                                    value={config.micModelId}
                                    onChange={setMicModel}
                                    options={availableModels}
                                    placeholder={t("Select mic model")}
                                />
                                <PremiumSelect
                                    label={t("System Audio Model")}
                                    value={config.systemModelId}
                                    onChange={setSystemModel}
                                    options={availableModels}
                                    placeholder={t("Select system model")}
                                />
                            </m.div>
                        ) : (
                            <m.div
                                key="global"
                                initial={{ opacity: 0, y: -10 }}
                                animate={{ opacity: 1, y: 0 }}
                                exit={{ opacity: 0, y: -10 }}
                                transition={{ duration: 0.2, ease: "easeOut" }}
                            >
                                <PremiumSelect
                                    label={t("Global Model")}
                                    value={config.globalModelId}
                                    onChange={setGlobalModel}
                                    options={availableModels}
                                    placeholder={t("Select global model")}
                                />
                            </m.div>
                        )}
                    </AnimatePresence>
                </div>
            </div>

            <div className="bg-bg-card rounded-xl border border-border-subtle overflow-hidden shadow-sm relative z-0">
                <div className="px-5 py-4 bg-bg-elevated/50 border-b border-border-subtle flex justify-between items-center">
                    <h3 className="text-sm font-semibold text-text-primary">{t('Model Manager')}</h3>
                    {hardware?.recommendedModel && (
                        <span className="text-[11px] text-text-tertiary font-medium bg-bg-input px-2 py-1 rounded-md border border-border-subtle">
                            {t('Recommended for your')} {isMac ? 'Mac' : 'PC'}: <span className="text-text-primary">{models.find(m => m.id === hardware.recommendedModel)?.name}</span>
                        </span>
                    )}
                </div>
                
                <div className="p-4 space-y-3 bg-bg-elevated/20">
                    {models.map(model => {
                        const isDownloading = model.status === 'downloading' || downloadingSet.has(model.id);
                        const progress = downloadProgress[model.id] || 0;
                        const isAvailable = model.status === 'available';
                        const isError = model.status === 'error';
                        const isRecommended = hardware?.recommendedModel === model.id;
                        
                        return (
                            <div key={model.id} className="p-4 flex items-center justify-between bg-bg-card border border-border-subtle rounded-[14px] hover:shadow-sm hover:border-border-muted transition-[border-color,box-shadow] duration-200">
                                <div className="flex-1 min-w-0 pr-4">
                                    <div className="flex items-center gap-2 mb-1.5">
                                        <span className="text-sm font-medium text-text-primary truncate tracking-tight">{model.name}</span>
                                        {isRecommended && (
                                            <span className="px-1.5 py-0.5 rounded-[4px] bg-accent-subtle text-accent-primary text-[9px] font-bold uppercase tracking-wider">{t('Recommended')}</span>
                                        )}
                                        {model.requiresAppleSilicon && (
                                            <span className="px-1.5 py-0.5 rounded-[4px] bg-purple-500/10 text-purple-500 text-[9px] font-bold uppercase tracking-wider">Apple Silicon</span>
                                        )}
                                    </div>
                                    <div className="flex items-center gap-3.5 text-xs text-text-tertiary">
                                        <span className="flex items-center gap-1.5"><HardDrive size={13} className="opacity-70" /> {model.sizeMb} MB</span>
                                        <span className="flex items-center gap-1.5"><Zap size={13} className="opacity-70" /> {model.speed}</span>
                                        <span className="flex items-center gap-1.5"><Check size={13} className="opacity-70" /> {model.accuracy} {t('acc')}</span>
                                    </div>
                                    
                                    {isDownloading && (
                                        <div className="mt-3.5 pr-8">
                                            <div className="flex justify-between items-center text-[10px] text-text-secondary mb-1.5 uppercase tracking-wider font-semibold">
                                                <span>{t('Downloading...')}</span>
                                                <div className="flex items-center gap-2">
                                                    <span className="text-accent-primary tabular-nums">{Math.round(progress)}%</span>
                                                    <button
                                                        type="button"
                                                        onClick={(e) => { e.stopPropagation(); handleCancel(model.id); }}
                                                        className="text-text-tertiary hover:text-red-500 transition-colors duration-200 px-1.5 py-0.5 rounded-md hover:bg-red-500/10 normal-case tracking-normal font-medium"
                                                        title={t("Cancel download")}
                                                    >
                                                        {t('Cancel')}
                                                    </button>
                                                </div>
                                            </div>
                                            <div className="w-full h-1.5 bg-bg-input rounded-full overflow-hidden shadow-inner ring-1 ring-inset ring-black/5 dark:ring-white/5">
                                                <div
                                                    className="h-full bg-accent-primary transition-[width] duration-300 ease-out relative"
                                                    style={{ width: `${progress}%` }}
                                                >
                                                    <div className="absolute inset-0 bg-white/20 animate-pulse" />
                                                </div>
                                            </div>
                                        </div>
                                    )}
                                    
                                    {(model.status === 'error' || model.status === 'interrupted' || model.status === 'cancelled') && (
                                        <div className="mt-2.5 text-xs text-red-500 flex items-center gap-1.5 font-medium bg-red-500/10 px-2.5 py-1.5 rounded-md inline-flex">
                                            <AlertCircle size={14} />
                                            {model.status === 'interrupted'
                                                ? t('Download was interrupted. Click Install to retry.')
                                                : model.status === 'cancelled'
                                                  ? t('Download cancelled. Click Install to retry.')
                                                  : (model.errorMessage || t('Failed to download model'))}
                                        </div>
                                    )}
                                </div>
                                
                                <div className="flex-shrink-0 flex items-center gap-2">
                                    {!isAvailable && !isDownloading && (
                                        <button
                                            type="button"
                                            onClick={() => handleDownload(model.id)}
                                            className="group/btn relative h-[34px] px-4 flex items-center gap-1.5 rounded-[10px] bg-legacy-action-subtle hover:bg-legacy-action-subtle-hover text-legacy-action-bg text-[13px] font-semibold transition-[background-color,color,transform,box-shadow] duration-300 ease-[cubic-bezier(0.23,1,0.32,1)] active:scale-[0.96] shadow-sm"
                                        >
                                            <Download size={14} className="transition-transform duration-300 group-hover/btn:-translate-y-[2px]" />
                                            <span>{model.status === 'error' || model.status === 'interrupted' || model.status === 'cancelled' ? t('Retry') : t('Install')}</span>
                                        </button>
                                    )}
                                    
                                    {isAvailable && (
                                        <button
                                            type="button"
                                            onClick={() => handleDelete(model.id)}
                                            className="p-2 rounded-[10px] text-text-tertiary hover:bg-red-500/10 hover:text-red-500 transition-[background-color,color,transform] duration-300 ease-[cubic-bezier(0.23,1,0.32,1)] active:scale-[0.96]"
                                            title={t("Delete model")}
                                        >
                                            <Trash2 size={16} />
                                        </button>
                                    )}
                                </div>
                            </div>
                        );
                    })}
                </div>
            </div>
            
            {/* ── Footer note ── */}
            {hardware?.tier === 'limited' && (
                <div className="pt-1 text-center">
                    <p className="text-[10px] font-medium text-amber-500 dark:text-amber-400/80 uppercase tracking-widest">
                        ⓘ {t('Limited hardware — cloud STT recommended for long sessions')}
                    </p>
                </div>
            )}
        </div>
        </LazyMotion>
    );
}

/**
 * Compact status chip for the three "silent background" local models
 * (intent / embeddings / reranker). Smaller than the full Whisper banner
 * because the user doesn't otherwise notice these degraded paths.
 *
 * "Retry now" calls the `onnx-reset-family` IPC to clear the cold-start
 * poison flag in the main process. The user must reopen the panel to see
 * the actual retry attempt — the next `ensureLoaded()` will try a fresh
 * spawn; if it succeeds the chip will simply not reappear next launch
 * because the disk sentinel was cleared on `ready`.
 */
function OnnxRecoveryChip({
    title,
    family,
    notice,
    onDismiss,
}: {
    title: string;
    family: OnnxRecoveryNotice['family'];
    notice: OnnxRecoveryNotice;
    onDismiss: () => void;
}) {
    const t = useT();
    const [retrying, setRetrying] = useState(false);
    const handleRetry = useCallback(async () => {
        setRetrying(true);
        try {
            await electronAPI?.onnxResetFamily?.(family);
        } finally {
            setRetrying(false);
            onDismiss();
        }
    }, [family, onDismiss]);
    return (
        <div className="bg-amber-500/5 border border-amber-500/15 rounded-xl p-3 flex items-start gap-3 text-amber-700 dark:text-amber-300/90">
            <AlertCircle size={14} className="mt-0.5 flex-shrink-0 opacity-80" />
            <div className="flex-1 min-w-0">
                <div className="text-xs font-semibold text-text-primary">{title}</div>
                <p className="text-[11px] text-text-secondary mt-0.5 leading-relaxed">
                    {notice.message}
                </p>
                <div className="mt-2 flex items-center gap-3">
                    <button
                        type="button"
                        onClick={handleRetry}
                        disabled={retrying}
                        className="text-[11px] font-semibold text-accent-primary hover:underline disabled:opacity-50"
                    >
                        {retrying ? t('Retrying…') : t('Retry now')}
                    </button>
                    <span className="text-[10px] text-text-tertiary">
                        {t('Skipped model:')} <span className="font-mono">{notice.badModelId}</span>
                    </span>
                </div>
            </div>
            <button
                type="button"
                onClick={onDismiss}
                className="p-1 rounded-md text-text-tertiary hover:text-text-primary hover:bg-bg-elevated transition-colors"
                aria-label={t("Dismiss recovery notice")}
            >
                <X size={12} />
            </button>
        </div>
    );
}
