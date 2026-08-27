import { useCallback, useEffect, useReducer, useRef, useState } from 'react';

import type {
    AgentHookHealthMap,
    AgentSkillHealth,
    AppSettings,
    ArgvConfig,
    ArgvConfigChanges,
    Keybinding,
} from '@caxri/protocol';

import { caxri } from '../../lib/caxri';
import { setSettingsOpen, useDialogStore } from '../../stores/dialogs';
import { describeFailure, pushToast } from '../../stores/toasts';
import { refreshWorkbench } from '../../stores/workbench';
import type { ConfigKind } from './config-edit';
import { applyFormEdit, CONFIG_FILE_NAMES, CONFIG_KINDS } from './config-edit';
import {
    appendKeybindingSource,
    removeKeybindingSource,
    updateKeybindingSource,
} from './keybinding-editor';
import type { ConfigAction } from './settings-drafts';
import { configReducer, initialConfigState, parseConfigSource } from './settings-drafts';
import { createSettingsWriteCoordinator } from './settings-write-coordinator';

const onApplied = (): void => {
    // Fire-and-forget: `refreshWorkbench` reports failures through its own request pipeline, so
    // callers of this synchronous-looking wrapper never need to await the outcome.
    // eslint-disable-next-line no-void -- intentional floating-promise discard, see above
    void refreshWorkbench();
};
const onSettingsError = (error: unknown, label: string): void =>
    pushToast('error', describeFailure(error, label));

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
    // Stable callbacks and Server events need the latest reducer state without resubscribing the
    // event listener on every edit. Every config action advances this ref in dispatch order, while
    // the effect confirms it from React's committed state.
    const stateReference = useRef(state);
    useEffect(() => {
        stateReference.current = state;
    }, [state]);
    const dispatchConfig = useCallback((action: ConfigAction): void => {
        /**
         * Server events can arrive back-to-back before React commits. Advance the event handler's reference through the
         * same reducer synchronously so a second event observes the first event's baseline without mutating render
         * state outside React.
         */
        stateReference.current = configReducer(stateReference.current, action);
        dispatch(action);
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

    const writeCoordinatorReference = useRef<
        ReturnType<typeof createSettingsWriteCoordinator> | undefined
    >(undefined);
    writeCoordinatorReference.current ??= createSettingsWriteCoordinator({
        appliedSource: (kind) => stateReference.current[kind].appliedSource,
        currentSource: (kind) => stateReference.current[kind].source,
        onApplied,
        onError: (error, kind) => {
            // Never applied to state on failure, so the field the user just changed stays exactly as they left it.
            onSettingsError(error, CONFIG_FILE_NAMES[kind]);
        },
        onExternalChange: (kind, payload) => {
            if (payload.error) {
                setSourceError(kind, payload.error);
                return;
            }
            if (kind === 'settings') {
                const parsed = parseConfigSource('settings', payload.source);
                dispatchConfig({
                    type: 'settings/externalChanged',
                    source: payload.source,
                    value: parsed.ok ? parsed.value : undefined,
                });
                setSourceError('settings', parsed.ok ? undefined : parsed.error);
                return;
            }
            if (kind === 'keybindings') {
                const parsed = parseConfigSource('keybindings', payload.source);
                dispatchConfig({
                    type: 'keybindings/externalChanged',
                    source: payload.source,
                    value: parsed.ok ? parsed.value : undefined,
                });
                setSourceError('keybindings', parsed.ok ? undefined : parsed.error);
                return;
            }
            const parsed = parseConfigSource('theme', payload.source);
            dispatchConfig({
                type: 'theme/externalChanged',
                source: payload.source,
                value: parsed.ok ? parsed.value : undefined,
            });
            setSourceError('theme', parsed.ok ? undefined : parsed.error);
        },
        onOwnEcho: (kind, source, isCurrentDraft) => {
            if (kind === 'settings') dispatchConfig({ type: 'settings/echoApplied', source });
            else if (kind === 'keybindings')
                dispatchConfig({ type: 'keybindings/echoApplied', source });
            else dispatchConfig({ type: 'theme/echoApplied', source });
            if (isCurrentDraft) setSourceError(kind);
        },
        persist: async (kind, source) => {
            if (kind === 'settings') {
                const result = await caxri.request('settings.update', { source });
                return () =>
                    dispatchConfig({
                        type: 'settings/applied',
                        value: result.value,
                        source: result.source,
                    });
            }
            if (kind === 'keybindings') {
                const result = await caxri.request('keybindings.update', { source });
                return () =>
                    dispatchConfig({
                        type: 'keybindings/applied',
                        value: result.value,
                        source: result.source,
                        conflicts: result.conflicts,
                    });
            }
            const result = await caxri.request('theme.update', { source });
            return () =>
                dispatchConfig({
                    type: 'theme/applied',
                    value: result.value,
                    source: result.source,
                });
        },
        read: async (kind) => {
            if (kind === 'settings') {
                const result = await caxri.request('settings.get');
                return () =>
                    dispatchConfig({
                        type: 'settings/reconciled',
                        value: result.value,
                        source: result.source,
                    });
            }
            if (kind === 'keybindings') {
                const result = await caxri.request('keybindings.get');
                return () =>
                    dispatchConfig({
                        type: 'keybindings/reconciled',
                        value: result.value,
                        source: result.source,
                        conflicts: result.conflicts,
                    });
            }
            const result = await caxri.request('theme.get');
            return () =>
                dispatchConfig({
                    type: 'theme/reconciled',
                    value: result.value,
                    source: result.source,
                });
        },
    });
    const writeCoordinator = writeCoordinatorReference.current;
    const persistNow = writeCoordinator.persistNow;
    const schedulePersist = writeCoordinator.schedule;

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
                dispatchConfig({
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
    }, [dispatchConfig]);

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

    /**
     * Parses the raw source text for `kind` and, when valid, refreshes the structured value and persists immediately —
     * no debounce, since losing focus (or switching away) is already the deliberate commit boundary. An invalid parse
     * reports inline next to the editor and is never sent to the Server.
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
                dispatchConfig({ type: 'settings/sourceParsed', value: result.value });
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
                dispatchConfig({ type: 'keybindings/sourceParsed', value: result.value });
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
            dispatchConfig({ type: 'theme/sourceParsed', value: result.value });
            if (entry.source !== entry.appliedSource) persistNow('theme', entry.source);
        },
        [dispatchConfig, persistNow, setSourceError],
    );

    useEffect(() => {
        const coordinator = writeCoordinatorReference.current;
        if (!coordinator) return;
        return caxri.onEvent((event) => {
            if (event.event === 'agentHooks.changed') {
                setAgentHookHealth(event.payload);
                return;
            }
            // Reducer state is meaningless before the first `load()`, so external pushes that
            // arrive before the dialog has ever been opened are ignored; the eventual `load()`
            // reads the current file anyway.
            if (!loaded) return;
            if (
                event.event === 'state.changed' &&
                event.payload.kind === 'full' &&
                event.payload.reason === 'unknown'
            ) {
                for (const kind of CONFIG_KINDS) {
                    // eslint-disable-next-line no-void -- each reconciliation reports its own read failure.
                    void coordinator.reconcile(kind);
                }
                return;
            }
            if (event.event === 'settings.changed') {
                coordinator.handleChanged('settings', event.payload);
                return;
            }
            if (event.event === 'keybindings.changed') {
                coordinator.handleChanged('keybindings', event.payload);
                return;
            }
            if (event.event === 'theme.changed') coordinator.handleChanged('theme', event.payload);
        });
    }, [loaded]);

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
            if (request.view === 'hardware-acceleration') {
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
        if (kind === 'settings') dispatchConfig({ type: 'settings/sourceChanged', source });
        else if (kind === 'keybindings')
            dispatchConfig({ type: 'keybindings/sourceChanged', source });
        else dispatchConfig({ type: 'theme/sourceChanged', source });
        const parsed = parseConfigSource(kind, source);
        setSourceError(kind, parsed.ok ? undefined : parsed.error);
    };

    const updateSettingsField = <K extends keyof AppSettings>(
        key: K,
        value: AppSettings[K],
    ): void => {
        if (!state.settings.value) return;
        const nextSource = applyFormEdit(state.settings.source, [key], value);
        dispatchConfig({
            type: 'settings/changed',
            value: { ...state.settings.value, [key]: value },
            source: nextSource,
        });
        schedulePersist('settings', nextSource);
    };

    const updateBinding = (index: number, key: string): void => {
        const nextSource = updateKeybindingSource(state.keybindings.source, index, key);
        dispatchConfig({
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
        dispatchConfig({
            type: 'keybindings/changed',
            value: [...state.keybindings.value, binding],
            source: nextSource,
        });
        schedulePersist('keybindings', nextSource);
    };

    const removeBinding = (index: number): void => {
        const nextSource = removeKeybindingSource(state.keybindings.source, index);
        dispatchConfig({
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
        dispatchConfig({
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
                if (
                    baseline &&
                    (result.value.remoteDebugging !== baseline.remoteDebugging ||
                        result.value.hardwareAcceleration !== baseline.hardwareAcceleration)
                )
                    pushToast(
                        'info',
                        'Boot configuration changes take effect after restarting Caxri',
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
            writeCoordinator.supersede('theme');
            const result = await caxri.request('theme.get');
            dispatchConfig({ type: 'theme/imported', value: result.value, source: result.source });
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
        hardwareAccelerationFocusRequestId:
            request.view === 'hardware-acceleration' ? request.id : undefined,
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
