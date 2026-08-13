import { Braces, FileJson, SlidersHorizontal } from 'lucide-react';
import { useCallback, useEffect, useReducer, useRef, useState } from 'react';

import type { AgentHookHealthMap, AppSettings, Keybinding } from '@shared/types';

import { ChromeTabPanel, ChromeTabs } from '../../components/ChromeTabs';
import { Button } from '../../components/ui/button';
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
} from '../../components/ui/dialog';
import { caxri } from '../../lib/caxri';
import { setSettingsOpen, useDialogStore } from '../../stores/dialogs';
import { describeFailure, pushToast } from '../../stores/toasts';
import { refreshWorkbench } from '../../stores/workbench';
import { applyFormEdit, CONFIG_FILE_NAMES, CONFIG_KINDS, type ConfigKind } from './config-edit';
import { ConfigurationSourceView } from './ConfigurationSourceView';
import {
    appendKeybindingSource,
    removeKeybindingSource,
    updateKeybindingSource,
} from './keybinding-editor';
import { KeybindingsForm } from './KeybindingsForm';
import { configReducer, initialConfigState, parseConfigSource } from './settings-drafts';
import { SettingsForm } from './SettingsForm';
import { ThemeForm } from './ThemeForm';

const onApplied = (): void => void refreshWorkbench();
const onError = (error: unknown, label: string): void =>
    pushToast('error', describeFailure(error, label));

/**
 * Coalesces a burst of structured-control edits (rapid typing, a dragged color picker) into one
 * persisted write per kind instead of a request per keystroke. The visible value always updates
 * instantly through the reducer; only the network write is delayed.
 */
const WRITE_DEBOUNCE_MS = 300;

function useSettingsDialogController() {
    const open = useDialogStore((state) => state.settingsOpen);
    const request = useDialogStore((state) => state.settingsRequest);
    const onOpenChange = setSettingsOpen;
    const [tab, setTab] = useState<ConfigKind>('settings');
    const [view, setView] = useState<'ui' | 'source'>('ui');
    const [sourceErrors, setSourceErrors] = useState<Partial<Record<ConfigKind, string>>>({});
    const [loaded, setLoaded] = useState(false);
    const [agentHookHealth, setAgentHookHealth] = useState<AgentHookHealthMap>();
    const handledRequestId = useRef(0);

    const [state, dispatch] = useReducer(configReducer, initialConfigState);
    // `commitSource`/`handleExternalChange` are stable callbacks (empty/narrow dep arrays) that
    // still need the latest reducer state; a ref synced in an effect (never during render) gives
    // them that without resubscribing the event listener on every dispatch.
    const stateRef = useRef(state);
    useEffect(() => {
        stateRef.current = state;
    }, [state]);

    // Per-kind write coordination: `writeTimers` holds a pending debounced write, and
    // `writeGeneration` lets an in-flight response detect it has been superseded by a newer edit
    // (or an external disk change) so it can drop itself silently instead of clobbering newer text.
    const writeTimers = useRef<Partial<Record<ConfigKind, number>>>({});
    const writeGeneration = useRef<Record<ConfigKind, number>>({
        settings: 0,
        keybindings: 0,
        theme: 0,
    });

    const persistNow = useCallback((kind: ConfigKind, source: string): void => {
        const timer = writeTimers.current[kind];
        if (timer !== undefined) window.clearTimeout(timer);
        delete writeTimers.current[kind];
        const generation = ++writeGeneration.current[kind];
        void (async (): Promise<void> => {
            try {
                if (kind === 'settings') {
                    const result = await caxri.request('settings.update', { source });
                    if (writeGeneration.current.settings !== generation) return;
                    dispatch({
                        type: 'settings/applied',
                        value: result.value,
                        source: result.source,
                    });
                } else if (kind === 'keybindings') {
                    const result = await caxri.request('keybindings.update', { source });
                    if (writeGeneration.current.keybindings !== generation) return;
                    dispatch({
                        type: 'keybindings/applied',
                        value: result.value,
                        source: result.source,
                        conflicts: result.conflicts,
                    });
                } else {
                    const result = await caxri.request('theme.update', { source });
                    if (writeGeneration.current.theme !== generation) return;
                    dispatch({ type: 'theme/applied', value: result.value, source: result.source });
                }
                onApplied();
            } catch (error) {
                // Never applied to state on failure, so the field the user just changed stays
                // exactly as they left it — the "tell the user, do not revert" rule.
                onError(error, CONFIG_FILE_NAMES[kind]);
            }
        })();
    }, []);

    const schedulePersist = useCallback(
        (kind: ConfigKind, source: string): void => {
            const timer = writeTimers.current[kind];
            if (timer !== undefined) window.clearTimeout(timer);
            writeTimers.current[kind] = window.setTimeout(
                () => persistNow(kind, source),
                WRITE_DEBOUNCE_MS,
            );
        },
        [persistNow],
    );

    const load = useCallback((): void => {
        void Promise.all([
            caxri.request('settings.get'),
            caxri.request('keybindings.get'),
            caxri.request('theme.get'),
            caxri.request('agentHooks.get'),
        ])
            .then(([settingsResult, keybindingsResult, themeResult, hookHealth]) => {
                dispatch({
                    type: 'loaded',
                    settings: { value: settingsResult.value, source: settingsResult.source },
                    keybindings: {
                        value: keybindingsResult.value,
                        source: keybindingsResult.source,
                        conflicts: keybindingsResult.conflicts,
                    },
                    theme: { value: themeResult.value, source: themeResult.source },
                });
                setAgentHookHealth(hookHealth);
                setLoaded(true);
            })
            .catch((error: unknown) => onError(error, 'Unable to load configuration'));
    }, []);

    const setSourceError = useCallback((kind: ConfigKind, error?: string): void => {
        setSourceErrors((current) => {
            if (current[kind] === error) return current;
            const next = { ...current };
            if (error) next[kind] = error;
            else delete next[kind];
            return next;
        });
    }, []);

    /**
     * Parses the raw source text for `kind` and, when valid, refreshes the structured value and
     * persists immediately — no debounce, since losing focus (or switching away) is already the
     * deliberate commit boundary. An invalid parse reports inline next to the editor and is never
     * sent to the Runtime.
     */
    const commitSource = useCallback(
        (kind: ConfigKind): void => {
            if (kind === 'settings') {
                const entry = stateRef.current.settings;
                const result = parseConfigSource('settings', entry.source);
                if (!result.ok) {
                    setSourceError('settings', result.error);
                    return;
                }
                setSourceError('settings');
                dispatch({ type: 'settings/sourceParsed', value: result.value });
                if (entry.source !== entry.appliedSource) persistNow('settings', entry.source);
                return;
            }
            if (kind === 'keybindings') {
                const entry = stateRef.current.keybindings;
                const result = parseConfigSource('keybindings', entry.source);
                if (!result.ok) {
                    setSourceError('keybindings', result.error);
                    return;
                }
                setSourceError('keybindings');
                dispatch({ type: 'keybindings/sourceParsed', value: result.value });
                if (entry.source !== entry.appliedSource) persistNow('keybindings', entry.source);
                return;
            }
            const entry = stateRef.current.theme;
            const result = parseConfigSource('theme', entry.source);
            if (!result.ok) {
                setSourceError('theme', result.error);
                return;
            }
            setSourceError('theme');
            dispatch({ type: 'theme/sourceParsed', value: result.value });
            if (entry.source !== entry.appliedSource) persistNow('theme', entry.source);
        },
        [persistNow, setSourceError],
    );

    /**
     * Reflects an external `*.changed` push (an edit made through "Open Config File", or our own
     * write echoing back) into the dialog, so it never shows stale data — the live-verified bug
     * this closes had the Theme tab keep showing the previous theme's name and swatches after the
     * active theme changed. Disk changes replace the current buffer unconditionally, matching the
     * app's explicit external-change rule, and supersede any in-flight write for that kind.
     */
    const handleExternalChange = useCallback(
        (kind: ConfigKind, payload: { source: string; error?: string }): void => {
            const current = stateRef.current[kind];
            // Our own write's broadcast echoes back exactly the text we just persisted — skip the
            // redundant reparse/redispatch instead of treating it as a foreign change.
            if (payload.source === current.appliedSource) return;
            const timer = writeTimers.current[kind];
            if (timer !== undefined) window.clearTimeout(timer);
            delete writeTimers.current[kind];
            writeGeneration.current[kind] += 1;
            if (kind === 'settings') {
                const parsed = parseConfigSource('settings', payload.source);
                dispatch({
                    type: 'settings/externalChanged',
                    source: payload.source,
                    value: parsed.ok ? parsed.value : undefined,
                });
                setSourceError('settings', payload.error ?? (parsed.ok ? undefined : parsed.error));
                return;
            }
            if (kind === 'keybindings') {
                const parsed = parseConfigSource('keybindings', payload.source);
                dispatch({
                    type: 'keybindings/externalChanged',
                    source: payload.source,
                    value: parsed.ok ? parsed.value : undefined,
                });
                setSourceError(
                    'keybindings',
                    payload.error ?? (parsed.ok ? undefined : parsed.error),
                );
                return;
            }
            const parsed = parseConfigSource('theme', payload.source);
            dispatch({
                type: 'theme/externalChanged',
                source: payload.source,
                value: parsed.ok ? parsed.value : undefined,
            });
            setSourceError('theme', payload.error ?? (parsed.ok ? undefined : parsed.error));
        },
        [setSourceError],
    );

    useEffect(
        () =>
            caxri.onEvent((event) => {
                if (event.event === 'agentHooks.changed') {
                    setAgentHookHealth(event.payload);
                    return;
                }
                // Reducer state is meaningless before the first `load()`, so external pushes that
                // arrive before the dialog has ever been opened are ignored; the eventual `load()`
                // reads the current file anyway.
                if (!loaded) return;
                if (event.event === 'settings.changed') {
                    handleExternalChange('settings', event.payload);
                    return;
                }
                if (event.event === 'keybindings.changed') {
                    handleExternalChange('keybindings', event.payload);
                    return;
                }
                if (event.event === 'theme.changed') handleExternalChange('theme', event.payload);
            }),
        [handleExternalChange, loaded],
    );

    // Only load once per app session: reopening the dialog after edits must keep the in-memory
    // state instead of re-reading from disk (external changes already stay in sync via the event
    // subscription above).
    useEffect(() => {
        if (open && !loaded) load();
    }, [load, open, loaded]);

    useEffect(() => {
        if (!loaded || handledRequestId.current === request.id) return;
        let cancelled = false;
        /** Defer the local view transition and consume the request only after StrictMode cleanup. */
        queueMicrotask(() => {
            if (cancelled || handledRequestId.current === request.id) return;
            handledRequestId.current = request.id;
            if (view === 'source') commitSource(tab);
            if (request.view === 'source') {
                setTab('settings');
                setView('source');
                return;
            }
            if (request.view === 'trusted-domains') {
                setTab('settings');
                setView('ui');
                return;
            }
            if (request.view === 'keybindings') {
                setTab('keybindings');
                setView('ui');
                return;
            }
            setView('ui');
        });
        return () => {
            cancelled = true;
        };
    }, [commitSource, loaded, request.id, request.view, tab, view]);

    const changeTab = (next: ConfigKind): void => {
        if (next === tab) return;
        if (view === 'source') commitSource(tab);
        setTab(next);
    };

    const showUi = (): void => {
        commitSource(tab);
        setView('ui');
    };

    const showSource = (): void => {
        setSourceError(tab);
        setView('source');
    };

    const updateSource = (kind: ConfigKind, source: string): void => {
        if (kind === 'settings') dispatch({ type: 'settings/sourceChanged', source });
        else if (kind === 'keybindings') dispatch({ type: 'keybindings/sourceChanged', source });
        else dispatch({ type: 'theme/sourceChanged', source });
        const parsed = parseConfigSource(kind, source);
        setSourceError(kind, parsed.ok ? undefined : parsed.error);
    };

    const updateSettingsField = <K extends keyof AppSettings>(
        key: K,
        value: AppSettings[K],
    ): void => {
        if (!state.settings.value) return;
        const nextSource = applyFormEdit(state.settings.source, [key], value);
        dispatch({
            type: 'settings/changed',
            value: { ...state.settings.value, [key]: value },
            source: nextSource,
        });
        schedulePersist('settings', nextSource);
    };

    const updateBinding = (index: number, key: string): void => {
        const nextSource = updateKeybindingSource(state.keybindings.source, index, key);
        dispatch({
            type: 'keybindings/changed',
            value: state.keybindings.value.map((binding, at) =>
                at === index ? { ...binding, key } : binding,
            ),
            source: nextSource,
        });
        schedulePersist('keybindings', nextSource);
    };

    const addBinding = (command: string, key: string): void => {
        const binding: Keybinding = { command, key };
        const nextSource = appendKeybindingSource(
            state.keybindings.source,
            state.keybindings.value.length,
            binding,
        );
        dispatch({
            type: 'keybindings/changed',
            value: [...state.keybindings.value, binding],
            source: nextSource,
        });
        schedulePersist('keybindings', nextSource);
    };

    const removeBinding = (index: number): void => {
        const nextSource = removeKeybindingSource(state.keybindings.source, index);
        dispatch({
            type: 'keybindings/changed',
            value: state.keybindings.value.filter((_, at) => at !== index),
            source: nextSource,
        });
        schedulePersist('keybindings', nextSource);
    };

    const updateThemeColor = (
        section: 'colors' | 'terminal' | 'editor',
        key: string,
        value: string,
    ): void => {
        const theme = state.theme.value;
        if (!theme) return;
        const wasDracula = theme.id === 'dracula';
        const nextId = wasDracula ? 'custom-dracula' : theme.id;
        let nextSource = applyFormEdit(state.theme.source, [section, key], value);
        nextSource = applyFormEdit(nextSource, ['source'], 'custom');
        if (wasDracula) nextSource = applyFormEdit(nextSource, ['id'], nextId);
        dispatch({
            type: 'theme/changed',
            value: {
                ...theme,
                id: nextId,
                source: 'custom',
                [section]: { ...theme[section], [key]: value },
            },
            source: nextSource,
        });
        schedulePersist('theme', nextSource);
    };

    const importTheme = async (): Promise<void> => {
        try {
            const imported = await caxri.request('theme.import');
            if (!imported) return;
            // The importer writes theme.json directly: drop any pending debounced write and bump
            // the generation so a stale response cannot clobber the just-imported theme afterward.
            const timer = writeTimers.current.theme;
            if (timer !== undefined) window.clearTimeout(timer);
            delete writeTimers.current.theme;
            writeGeneration.current.theme += 1;
            const result = await caxri.request('theme.get');
            dispatch({ type: 'theme/imported', value: result.value, source: result.source });
            onApplied();
        } catch (error) {
            onError(error, 'Theme import failed');
        }
    };

    return {
        addBinding,
        agentHookHealth,
        changeTab,
        commitSource,
        importTheme,
        keybindingsFocusRequestId: request.view === 'keybindings' ? request.id : undefined,
        onOpenChange,
        open,
        removeBinding,
        showSource,
        showUi,
        sourceErrors,
        state,
        tab,
        trustedDomainsFocusRequestId: request.view === 'trusted-domains' ? request.id : undefined,
        updateBinding,
        updateSettingsField,
        updateSource,
        updateThemeColor,
        view,
    };
}

function SettingsDialogView({
    addBinding,
    agentHookHealth,
    changeTab,
    commitSource,
    importTheme,
    keybindingsFocusRequestId,
    onOpenChange,
    open,
    removeBinding,
    showSource,
    showUi,
    sourceErrors,
    state,
    tab,
    trustedDomainsFocusRequestId,
    updateBinding,
    updateSettingsField,
    updateSource,
    updateThemeColor,
    view,
}: ReturnType<typeof useSettingsDialogController>) {
    // Base UI's default `initialFocus` moves focus to the first tabbable element inside
    // the popup — the selected ChromeTabs tab button. When the dialog opens via a
    // keyboard shortcut that focus is keyboard-driven, so the tab's `focus-visible`
    // outline draws around it, which reads as a stray box rather than an intentional
    // affordance. Focusing the popup container itself instead avoids that, while Tab
    // still moves focus into the dialog's controls normally.
    const popupRef = useRef<HTMLDivElement>(null);
    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent
                ref={popupRef}
                initialFocus={popupRef}
                className="grid h-[min(760px,calc(100vh-48px))] w-[min(920px,calc(100vw-48px))] grid-rows-[auto_auto_minmax(0,1fr)_auto] overflow-hidden"
            >
                <DialogHeader>
                    <DialogTitle>Settings</DialogTitle>
                    <DialogDescription>
                        Changes apply immediately and are stored as editable files.
                    </DialogDescription>
                </DialogHeader>
                <div className="flex border-b border-border">
                    <ChromeTabs
                        ariaLabel="Settings sections"
                        className="flex flex-1"
                        idPrefix="settings"
                        items={CONFIG_KINDS.map((value) => ({
                            value,
                            label: value[0].toUpperCase() + value.slice(1),
                            content: value[0].toUpperCase() + value.slice(1),
                        }))}
                        tabClassName="min-h-9 px-4"
                        value={tab}
                        onValueChange={changeTab}
                    />
                    <Button
                        aria-label={
                            view === 'ui'
                                ? `Open ${CONFIG_FILE_NAMES[tab]} Source`
                                : `Back to ${tab[0].toUpperCase() + tab.slice(1)} UI`
                        }
                        aria-pressed={view === 'source'}
                        className="my-1 mr-2"
                        size="sm"
                        variant="ghost"
                        onClick={view === 'ui' ? showSource : showUi}
                    >
                        {view === 'ui' ? <Braces size={14} /> : <SlidersHorizontal size={14} />}
                        {view === 'ui' ? 'Source' : 'UI'}
                    </Button>
                </div>

                <ChromeTabPanel
                    active={tab === 'settings'}
                    className="grid min-h-0 overflow-hidden"
                    idPrefix="settings"
                    value="settings"
                >
                    {tab === 'settings' &&
                        state.settings.value &&
                        state.theme.value &&
                        (view === 'source' ? (
                            <ConfigurationSourceView
                                error={sourceErrors.settings}
                                kind="settings"
                                source={state.settings.source}
                                theme={state.theme.value}
                                onBlur={() => commitSource('settings')}
                                onChange={(source) => updateSource('settings', source)}
                            />
                        ) : (
                            <SettingsForm
                                agentHookHealth={agentHookHealth}
                                settings={state.settings.value}
                                trustedDomainsFocusRequestId={trustedDomainsFocusRequestId}
                                onFieldChange={updateSettingsField}
                            />
                        ))}
                </ChromeTabPanel>

                <ChromeTabPanel
                    active={tab === 'keybindings'}
                    className="grid min-h-0 overflow-hidden"
                    idPrefix="settings"
                    value="keybindings"
                >
                    {tab === 'keybindings' &&
                        state.theme.value &&
                        (view === 'source' ? (
                            <ConfigurationSourceView
                                error={sourceErrors.keybindings}
                                kind="keybindings"
                                source={state.keybindings.source}
                                theme={state.theme.value}
                                onBlur={() => commitSource('keybindings')}
                                onChange={(source) => updateSource('keybindings', source)}
                            />
                        ) : (
                            <KeybindingsForm
                                focusRequestId={keybindingsFocusRequestId}
                                keybindings={state.keybindings.value}
                                onAdd={addBinding}
                                onChange={updateBinding}
                                onRemove={removeBinding}
                            />
                        ))}
                </ChromeTabPanel>

                <ChromeTabPanel
                    active={tab === 'theme'}
                    className="grid min-h-0 overflow-hidden"
                    idPrefix="settings"
                    value="theme"
                >
                    {tab === 'theme' &&
                        state.theme.value &&
                        (view === 'source' ? (
                            <ConfigurationSourceView
                                error={sourceErrors.theme}
                                kind="theme"
                                source={state.theme.source}
                                theme={state.theme.value}
                                onBlur={() => commitSource('theme')}
                                onChange={(source) => updateSource('theme', source)}
                            />
                        ) : (
                            <ThemeForm
                                theme={state.theme.value}
                                onColorChange={updateThemeColor}
                                onImport={() => void importTheme()}
                            />
                        ))}
                </ChromeTabPanel>

                <footer className="dialog-actions flex justify-end gap-2 border-t border-border px-3 py-2">
                    <Button
                        variant="ghost"
                        onClick={() => void caxri.request('app.openConfigFile', { kind: tab })}
                    >
                        <FileJson size={14} /> Open Config File
                    </Button>
                </footer>
            </DialogContent>
        </Dialog>
    );
}

export function SettingsDialog() {
    const controller = useSettingsDialogController();
    return <SettingsDialogView {...controller} />;
}
