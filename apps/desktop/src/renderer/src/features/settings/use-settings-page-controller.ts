import { useCallback, useEffect, useReducer, useRef, useState } from 'react';

import type {
    AgentHookHealthMap,
    AgentSkillHealth,
    AppSettings,
    ArgvConfig,
    ArgvConfigChanges,
    Keybinding,
} from '@caxri/protocol';
import { builtinThemes, findMatchingBuiltinTheme } from '@caxri/protocol';

import { translate } from '../../i18n';
import { caxri } from '../../lib/caxri';
import { useDialogStore } from '../../stores/dialogs';
import {
    describeFailure,
    dismissToastsMatching,
    isCancelledRequest,
    pushToast,
} from '../../stores/toasts';
import { refreshWorkbench } from '../../stores/workbench';
import {
    argvRestartNotice,
    isArgvRestartNotice,
    rememberArgvRestartNotice,
} from './argv-restart-notice';
import type { ConfigKind } from './config-edit';
import { applyFormEdit, CONFIG_FILE_NAMES, CONFIG_KINDS } from './config-edit';
import {
    appendKeybindingSource,
    removeKeybindingSource,
    updateKeybindingSource,
} from './keybinding-editor';
import {
    getAgentHookHealth,
    getAgentSkillHealth,
    getArgvConfig,
    getKeybindings,
    getSettings,
    getTheme,
    importThemeFile,
    updateKeybindings,
    updateSettings,
    updateTheme,
    writeArgvConfig,
} from './settings-client';
import type { ConfigAction, ConfigSourceError } from './settings-drafts';
import { configReducer, initialConfigState, parseConfigSource } from './settings-drafts';
import { rowFocusRequest, scrolledSettingsViews } from './settings-focus-requests';
import { createSettingsWriteCoordinator } from './settings-write-coordinator';
import { applyBuiltinTheme, applyThemeColorEdit } from './theme-edit';
import type { ThemeImportResult } from './theme-import-error';
import { describeThemeImportFailure } from './theme-import-error';
import { resetThemeImportWarningDismissals } from './theme-import-warnings';

const onApplied = (): void => {
    // Fire-and-forget: `refreshWorkbench` reports failures through its own request pipeline, so
    // callers of this synchronous-looking wrapper never need to await the outcome.
    // eslint-disable-next-line no-void -- intentional floating-promise discard, see above
    void refreshWorkbench();
};
/**
 * Main answers every queued Renderer request with `CANCELLED` once quit starts, so a debounced write or reload still in
 * flight at quit must not raise a notification over a window that is already going away (same rule as `tryCommand`).
 */
export function reportSettingsError(error: unknown, label: string): void {
    if (isCancelledRequest(error)) return;
    pushToast('error', describeFailure(error, label));
}

export function useSettingsPageController() {
    const request = useDialogStore((state) => state.settingsRequest);
    const [tab, setTab] = useState<ConfigKind>('settings');
    const [view, setView] = useState<'ui' | 'source'>('ui');
    const [sourceErrors, setSourceErrors] = useState<
        Partial<Record<ConfigKind, ConfigSourceError>>
    >({});
    const [loaded, setLoaded] = useState(false);
    // No explicit reset-on-close: the Settings tab unmounts like any other document tab when it stops being the active
    // tab in its pane, which already clears every piece of local state below, this one included.
    const [themeImportResult, setThemeImportResult] = useState<ThemeImportResult | undefined>();
    const [agentHookHealth, setAgentHookHealth] = useState<AgentHookHealthMap>();
    const [agentSkillHealth, setAgentSkillHealth] = useState<AgentSkillHealth>();
    const [argvConfig, setArgvConfig] = useState<ArgvConfig>();
    const argvWriteGeneration = useRef(0);
    // Boot-session baseline for the restart hint: what the running instance actually launched
    // with, as of Settings load. Diverging from it needs a restart; returning to it does not.
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
    const setSourceError = useCallback(
        (kind: ConfigKind, error?: string | ConfigSourceError): void => {
            setSourceErrors((current) => {
                const nextError = typeof error === 'string' ? { error } : error;
                if (
                    current[kind]?.error === nextError?.error &&
                    current[kind]?.line === nextError?.line
                )
                    return current;
                const next = { ...current };
                if (nextError) next[kind] = nextError;
                else delete next[kind];
                return next;
            });
        },
        [],
    );

    const writeCoordinatorReference = useRef<
        ReturnType<typeof createSettingsWriteCoordinator> | undefined
    >(undefined);
    writeCoordinatorReference.current ??= createSettingsWriteCoordinator({
        appliedSource: (kind) => stateReference.current[kind].appliedSource,
        currentSource: (kind) => stateReference.current[kind].source,
        onApplied,
        onError: (error, kind) => {
            // Never applied to state on failure, so the field the user just changed stays exactly as they left it.
            reportSettingsError(error, CONFIG_FILE_NAMES[kind]);
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
                setSourceError('settings', parsed.ok ? undefined : parsed);
                return;
            }
            if (kind === 'keybindings') {
                const parsed = parseConfigSource('keybindings', payload.source);
                dispatchConfig({
                    type: 'keybindings/externalChanged',
                    source: payload.source,
                    value: parsed.ok ? parsed.value : undefined,
                });
                setSourceError('keybindings', parsed.ok ? undefined : parsed);
                return;
            }
            const parsed = parseConfigSource('theme', payload.source);
            dispatchConfig({
                type: 'theme/externalChanged',
                source: payload.source,
                value: parsed.ok ? parsed.value : undefined,
            });
            setSourceError('theme', parsed.ok ? undefined : parsed);
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
                const result = await updateSettings({ source });
                return () =>
                    dispatchConfig({
                        type: 'settings/applied',
                        value: result.value,
                        source: result.source,
                    });
            }
            if (kind === 'keybindings') {
                const result = await updateKeybindings({ source });
                return () =>
                    dispatchConfig({
                        type: 'keybindings/applied',
                        value: result.value,
                        source: result.source,
                        conflicts: result.conflicts,
                    });
            }
            const result = await updateTheme({ source });
            return () =>
                dispatchConfig({
                    type: 'theme/applied',
                    value: result.value,
                    source: result.source,
                });
        },
        read: async (kind) => {
            if (kind === 'settings') {
                const result = await getSettings();
                return () =>
                    dispatchConfig({
                        type: 'settings/reconciled',
                        value: result.value,
                        source: result.source,
                    });
            }
            if (kind === 'keybindings') {
                const result = await getKeybindings();
                return () =>
                    dispatchConfig({
                        type: 'keybindings/reconciled',
                        value: result.value,
                        source: result.source,
                        conflicts: result.conflicts,
                    });
            }
            const result = await getTheme();
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
                        getSettings(),
                        getKeybindings(),
                        getTheme(),
                        getAgentHookHealth(),
                        getArgvConfig(),
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
                reportSettingsError(error, translate('settings.page.loadFailed'));
            }
        }
        // eslint-disable-next-line no-void -- intentional floating-promise discard, see above
        void loadConfig();
    }, [dispatchConfig]);

    const loadAgentSkillHealth = useCallback((): void => {
        async function loadSkillHealth(): Promise<void> {
            try {
                setAgentSkillHealth(await getAgentSkillHealth());
            } catch (error: unknown) {
                reportSettingsError(error, translate('settings.page.skillHealthFailed'));
            }
        }
        // eslint-disable-next-line no-void -- intentional floating-promise discard, see above
        void loadSkillHealth();
    }, []);

    /**
     * Parses the raw source text for `kind` and, when valid, refreshes the structured value and persists immediately:
     * no debounce, since losing focus (or switching away) is already the deliberate commit boundary. An invalid parse
     * reports inline next to the editor and is never sent to the Server.
     */
    const commitSource = useCallback(
        (kind: ConfigKind): void => {
            if (kind === 'settings') {
                const entry = stateReference.current.settings;
                const result = parseConfigSource('settings', entry.source);
                if (!result.ok) {
                    setSourceError('settings', result);
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
                    setSourceError('keybindings', result);
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
                setSourceError('theme', result);
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
            // arrive before this mount's own `load()` has resolved are ignored; that pending
            // `load()` reads the current file anyway.
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

    // Only load once per mount: further edits inside this session must keep the in-memory state
    // instead of re-reading from disk (external changes already stay in sync via the event
    // subscription above). Switching away from the Settings tab and back is a fresh mount, and
    // therefore a fresh read, same as reopening any other document tab.
    useEffect(() => {
        if (!loaded) load();
    }, [load, loaded]);

    // Provider skill files can change through the offline CLI while the app is running. Refresh on
    // mount instead of persisting derived filesystem health or showing the first read forever.
    useEffect(() => {
        loadAgentSkillHealth();
    }, [loadAgentSkillHealth]);

    useEffect(() => {
        if (handledRequestId.current === request.id) return;
        let isCancelled = false;
        /**
         * Consume navigation independently of configuration loading. The tabs are already interactive while reads are
         * pending; deferring the open request until they finish overwrites a newer user-selected tab. The microtask
         * still lets StrictMode cleanup cancel its first effect pass.
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
            if (request.view === 'agent-actions' || request.view === 'agent-executable') {
                setTab('settings');
                setView('ui');
                return;
            }
            if (scrolledSettingsViews.has(request.view)) {
                setTab('settings');
                setView('ui');
                return;
            }
            if (request.view === 'keybindings') {
                setTab('keybindings');
                setView('ui');
                return;
            }
            /**
             * An untargeted open is the Settings tab. Leaving the tab wherever the last open left it would hand `Cmd+,`
             * to Theme or Keybindings, where the search field this request focuses does not exist.
             */
            setTab('settings');
            setView('ui');
        });
        return () => {
            isCancelled = true;
        };
    }, [commitSource, request.id, request.view, tab, view]);

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
        setSourceError(kind, parsed.ok ? undefined : parsed);
    };

    /**
     * `member` names the one field inside a complex setting that actually changed. Without it the whole key is written,
     * which replaces that key's JSONC node and takes every comment the user wrote inside it along with it. `value`
     * stays the complete new value so call sites keep their types; only the source edit narrows.
     */
    const updateSettingsField = <K extends keyof AppSettings>(
        key: K,
        value: AppSettings[K],
        member?: string,
    ): void => {
        if (!state.settings.value) return;
        const nextSource =
            member === undefined
                ? applyFormEdit(state.settings.source, [key], value)
                : applyFormEdit(
                      state.settings.source,
                      [key, member],
                      (value as Record<string, unknown>)[member],
                  );
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
        const next = applyThemeColorEdit(state.theme.source, theme, section, key, value);
        dispatchConfig({
            type: 'theme/changed',
            value: next.value,
            source: next.source,
        });
        schedulePersist('theme', next.source);
    };

    const selectBuiltinTheme = (id: string): void => {
        const theme = builtinThemes.find((candidate) => candidate.id === id);
        if (!theme || (state.theme.value && findMatchingBuiltinTheme(state.theme.value)?.id === id))
            return;
        const next = applyBuiltinTheme(state.theme.source, theme);
        dispatchConfig({ type: 'theme/changed', value: next.value, source: next.source });
        persistNow('theme', next.source);
    };

    const updateArgvConfig = (changes: ArgvConfigChanges): void => {
        // Main-owned boot config (`argv.jsonc`): written directly through its desktop method, not
        // the settings.jsonc draft/debounce pipeline. Optimistic update, "tell the user, do not
        // revert" on failure, matching the settings write path above; the generation counter drops
        // out-of-order responses from rapid toggles, mirroring `writeGeneration`.
        setArgvConfig((current) => (current ? { ...current, ...changes } : current));
        const generation = ++argvWriteGeneration.current;
        // eslint-disable-next-line no-void -- intentional floating-promise discard, the IIFE below reports its own errors via reportSettingsError
        void (async (): Promise<void> => {
            try {
                const result = await writeArgvConfig({ changes });
                if (argvWriteGeneration.current !== generation) return;
                setArgvConfig(result.value);
                const notice = argvRestartNotice({
                    applied: result.value,
                    baseline: argvConfigAtLoad.current,
                });
                // The card is a status, not an event: retract the previous wording first so a write that changes which
                // flags are pending (including one that returns the last of them to its launch value) can never leave
                // a stale instruction on screen.
                dismissToastsMatching(isArgvRestartNotice);
                // Held until dismissed: the user is still looking at the Settings row they just flipped, so a
                // four-second expiry would take away the only record of the restart they now owe before they can act
                // on it.
                if (notice) {
                    rememberArgvRestartNotice(notice);
                    pushToast('info', notice, { persist: true });
                }
            } catch (error) {
                reportSettingsError(error, 'argv.jsonc');
            }
        })();
    };

    const importTheme = async (): Promise<void> => {
        // Cleared first so a second attempt cannot leave the previous answer standing while the native picker is open.
        setThemeImportResult(undefined);
        try {
            const imported = await importThemeFile();
            if (!imported) return;
            // The importer writes theme.json directly: drop any pending debounced write and bump
            // the generation so a stale response cannot clobber the just-imported theme afterward.
            writeCoordinator.supersede('theme');
            const result = await getTheme();
            // The import response is the only source of transient warnings; theme.get reads saved tokens only.
            resetThemeImportWarningDismissals(imported.value.id);
            dispatchConfig({
                type: 'theme/imported',
                value: imported.value,
                source: result.source,
                warnings: imported.warnings,
            });
            onApplied();
            setThemeImportResult({ kind: 'imported', themeName: imported.value.name });
        } catch (error) {
            setThemeImportResult({ kind: 'failed', message: describeThemeImportFailure(error) });
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
        agentExecutableFocusRequest:
            request.view === 'agent-executable' && request.provider
                ? { id: request.id, provider: request.provider }
                : undefined,
        argvConfig,
        changeTab,
        commitSource,
        gitExclusionsFocusRequestId: request.view === 'git-exclusions' ? request.id : undefined,
        rowFocusRequest: rowFocusRequest(request),
        /**
         * Only an untargeted open claims the caret. Every other view either scrolls to a row or hands focus to the
         * editor it opened, and a search field that grabbed focus over those would undo the request the user made.
         */
        searchFocusRequestId: request.view === 'ui' ? request.id : undefined,
        importTheme,
        themeImportResult,
        dismissThemeImportResult: () => setThemeImportResult(undefined),
        keybindingsFocusRequestId: request.view === 'keybindings' ? request.id : undefined,
        removeBinding,
        showSource,
        showUi,
        selectBuiltinTheme,
        sourceErrors,
        state,
        tab,
        trustedDomainsFocusRequestId: request.view === 'trusted-domains' ? request.id : undefined,
        notificationsFocusRequestId: request.view === 'notifications' ? request.id : undefined,
        updateArgvConfig,
        updateBinding,
        updateSettingsField,
        updateSource,
        updateThemeColor,
        view,
    };
}

export type SettingsPageController = ReturnType<typeof useSettingsPageController>;
