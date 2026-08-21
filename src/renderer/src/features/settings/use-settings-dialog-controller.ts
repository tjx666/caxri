import { useCallback, useEffect, useReducer, useRef, useState } from 'react';

import type {
    AgentHookHealthMap,
    AgentSkillHealth,
    AppSettings,
    ArgvConfig,
    ArgvConfigChanges,
    Keybinding,
} from '@shared/types';

import { caxri } from '../../lib/caxri';
import { setSettingsOpen, useDialogStore } from '../../stores/dialogs';
import { describeFailure, pushToast } from '../../stores/toasts';
import { refreshWorkbench } from '../../stores/workbench';
import type { ConfigKind } from './config-edit';
import { applyFormEdit, CONFIG_FILE_NAMES } from './config-edit';
import {
    appendKeybindingSource,
    removeKeybindingSource,
    updateKeybindingSource,
} from './keybinding-editor';
import { configReducer, initialConfigState, parseConfigSource } from './settings-drafts';

const onApplied = (): void => {
    // Fire-and-forget: `refreshWorkbench` reports failures through its own request pipeline, so
    // callers of this synchronous-looking wrapper never need to await the outcome.
    // eslint-disable-next-line no-void -- intentional floating-promise discard, see above
    void refreshWorkbench();
};
const onSettingsError = (error: unknown, label: string): void =>
    pushToast('error', describeFailure(error, label));

/**
 * Coalesces a burst of structured-control edits (rapid typing, a dragged color picker) into one persisted write per
 * kind instead of a request per keystroke. The visible value always updates instantly through the reducer; only the
 * network write is delayed.
 */
const WRITE_DEBOUNCE_MS = 300;

export function useSettingsDialogController() {
    const isOpen = useDialogStore((state) => state.settingsOpen);
    const request = useDialogStore((state) => state.settingsRequest);
    const onOpenChange = setSettingsOpen;
    const [tab, setTab] = useState<ConfigKind>('settings');
    const [view, setView] = useState<'ui' | 'source'>('ui');
    const [sourceErrors, setSourceErrors] = useState<Partial<Record<ConfigKind, string>>>({});
    const [loaded, setLoaded] = useState(false);
    const [agentHookHealth, setAgentHookHealth] = useState<AgentHookHealthMap>();
    const [agentSkillHealth, setAgentSkillHealth] = useState<AgentSkillHealth>();
    const [argvConfig, setArgvConfig] = useState<ArgvConfig>();
    const argvWriteGeneration = useRef(0);
    // Boot-session baseline for the restart hint: what the running instance actually launched
    // with, as of dialog load. Diverging from it needs a restart; returning to it does not.
    const argvConfigAtLoad = useRef<ArgvConfig | undefined>(undefined);
    const handledRequestId = useRef(0);

    const [state, dispatch] = useReducer(configReducer, initialConfigState);
    // `commitSource`/`handleExternalChange` are stable callbacks (empty/narrow dep arrays) that
    // still need the latest reducer state; a ref synced in an effect (never during render) gives
    // them that without resubscribing the event listener on every dispatch.
    const stateReference = useRef(state);
    useEffect(() => {
        stateReference.current = state;
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
        if (timer !== undefined) clearTimeout(timer);
        delete writeTimers.current[kind];
        const generation = ++writeGeneration.current[kind];
        // eslint-disable-next-line no-void -- intentional floating-promise discard, the IIFE below reports its own errors via onSettingsError
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
                onSettingsError(error, CONFIG_FILE_NAMES[kind]);
            }
        })();
    }, []);

    const schedulePersist = useCallback(
        (kind: ConfigKind, source: string): void => {
            const timer = writeTimers.current[kind];
            if (timer !== undefined) clearTimeout(timer);
            writeTimers.current[kind] = setTimeout(
                () => persistNow(kind, source),
                WRITE_DEBOUNCE_MS,
            );
        },
        [persistNow],
    );

    const load = useCallback((): void => {
        async function loadConfig(): Promise<void> {
            try {
                const [settingsResult, keybindingsResult, themeResult, hookHealth, argvResult] =
                    await Promise.all([
                        caxri.request('settings.get'),
                        caxri.request('keybindings.get'),
                        caxri.request('theme.get'),
                        caxri.request('agentHooks.get'),
                        caxri.request('argv.get'),
                    ]);
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
                setArgvConfig(argvResult.value);
                argvConfigAtLoad.current ??= argvResult.value;
                setLoaded(true);
            } catch (error: unknown) {
                onSettingsError(error, 'Unable to load configuration');
            }
        }
        // eslint-disable-next-line no-void -- intentional floating-promise discard, see above
        void loadConfig();
    }, []);

    const loadAgentSkillHealth = useCallback((): void => {
        async function loadSkillHealth(): Promise<void> {
            try {
                setAgentSkillHealth(await caxri.request('agentSkills.get'));
            } catch (error: unknown) {
                onSettingsError(error, 'Unable to inspect Caxri CLI skills');
            }
        }
        // eslint-disable-next-line no-void -- intentional floating-promise discard, see above
        void loadSkillHealth();
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
     * Parses the raw source text for `kind` and, when valid, refreshes the structured value and persists immediately —
     * no debounce, since losing focus (or switching away) is already the deliberate commit boundary. An invalid parse
     * reports inline next to the editor and is never sent to the Runtime.
     */
    const commitSource = useCallback(
        (kind: ConfigKind): void => {
            if (kind === 'settings') {
                const entry = stateReference.current.settings;
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
                const entry = stateReference.current.keybindings;
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
            const entry = stateReference.current.theme;
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
     * Reflects an external `*.changed` push (an edit made in an outside editor, or our own write echoing back) into the
     * dialog, so it never shows stale data — the live-verified bug this closes had the Theme tab keep showing the
     * previous theme's name and swatches after the active theme changed. Disk changes replace the current buffer
     * unconditionally, matching the app's explicit external-change rule, and supersede any in-flight write for that
     * kind.
     */
    const handleExternalChange = useCallback(
        (kind: ConfigKind, payload: { source: string; error?: string }): void => {
            const current = stateReference.current[kind];
            // Our own write's broadcast echoes back exactly the text we just persisted — skip the
            // redundant reparse/redispatch instead of treating it as a foreign change.
            if (payload.source === current.appliedSource) return;
            const timer = writeTimers.current[kind];
            if (timer !== undefined) clearTimeout(timer);
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
        if (isOpen && !loaded) load();
    }, [load, isOpen, loaded]);

    // Provider skill files can change through the offline CLI while the app is running. Refresh on
    // every open instead of persisting derived filesystem health or showing the first read forever.
    useEffect(() => {
        if (isOpen) loadAgentSkillHealth();
    }, [loadAgentSkillHealth, isOpen]);

    useEffect(() => {
        if (!loaded || handledRequestId.current === request.id) return;
        let isCancelled = false;
        /**
         * Defer the local view transition and consume the request only after StrictMode cleanup.
         */
        queueMicrotask(() => {
            if (isCancelled || handledRequestId.current === request.id) return;
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
            if (request.view === 'agent-actions') {
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
            isCancelled = true;
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

    const updateArgvConfig = (changes: ArgvConfigChanges): void => {
        // Main-owned boot config (`argv.jsonc`): written directly through its desktop method, not
        // the settings.jsonc draft/debounce pipeline. Optimistic update, "tell the user, do not
        // revert" on failure, matching the settings write path above; the generation counter drops
        // out-of-order responses from rapid toggles, mirroring `writeGeneration`.
        setArgvConfig((current) => (current ? { ...current, ...changes } : current));
        const generation = ++argvWriteGeneration.current;
        // eslint-disable-next-line no-void -- intentional floating-promise discard, the IIFE below reports its own errors via onSettingsError
        void (async (): Promise<void> => {
            try {
                const result = await caxri.request('argv.update', { changes });
                if (argvWriteGeneration.current !== generation) return;
                setArgvConfig(result.value);
                const baseline = argvConfigAtLoad.current;
                if (baseline && result.value.remoteDebugging !== baseline.remoteDebugging)
                    pushToast(
                        'info',
                        'Remote debugging changes take effect after restarting Caxri',
                    );
            } catch (error) {
                onSettingsError(error, 'argv.jsonc');
            }
        })();
    };

    const importTheme = async (): Promise<void> => {
        try {
            const imported = await caxri.request('theme.import');
            if (!imported) return;
            // The importer writes theme.json directly: drop any pending debounced write and bump
            // the generation so a stale response cannot clobber the just-imported theme afterward.
            const timer = writeTimers.current.theme;
            if (timer !== undefined) clearTimeout(timer);
            delete writeTimers.current.theme;
            writeGeneration.current.theme += 1;
            const result = await caxri.request('theme.get');
            dispatch({ type: 'theme/imported', value: result.value, source: result.source });
            onApplied();
        } catch (error) {
            onSettingsError(error, 'Theme import failed');
        }
    };

    return {
        addBinding,
        agentHookHealth,
        agentSkillHealth,
        agentActionsFocusRequest:
            request.view === 'agent-actions' && request.provider
                ? { id: request.id, provider: request.provider }
                : undefined,
        argvConfig,
        changeTab,
        commitSource,
        importTheme,
        keybindingsFocusRequestId: request.view === 'keybindings' ? request.id : undefined,
        onOpenChange,
        open: isOpen,
        removeBinding,
        showSource,
        showUi,
        sourceErrors,
        state,
        tab,
        trustedDomainsFocusRequestId: request.view === 'trusted-domains' ? request.id : undefined,
        updateArgvConfig,
        updateBinding,
        updateSettingsField,
        updateSource,
        updateThemeColor,
        view,
    };
}

export type SettingsDialogController = ReturnType<typeof useSettingsDialogController>;
