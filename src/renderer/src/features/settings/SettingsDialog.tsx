import { Braces, FileJson, Save, SlidersHorizontal } from 'lucide-react';
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';

import { findKeybindingConflicts } from '@shared/configuration';
import type { AppSettings, Keybinding } from '@shared/types';

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
import { cn } from '../../lib/utils';
import { setSettingsOpen, useDialogStore } from '../../stores/dialogs';
import { describeFailure, pushToast } from '../../stores/toasts';
import { refreshWorkbench } from '../../stores/workbench';
import {
    applyFormEdit,
    CONFIG_FILE_NAMES,
    CONFIG_KINDS,
    dirtyConfigKinds,
    isConfigDirty,
    type ConfigDrafts,
    type ConfigKind,
} from './config-edit';
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

export function SettingsDialog() {
    const open = useDialogStore((state) => state.settingsOpen);
    const request = useDialogStore((state) => state.settingsRequest);
    const onOpenChange = setSettingsOpen;
    const [tab, setTab] = useState<ConfigKind>('settings');
    const [view, setView] = useState<'ui' | 'source'>('ui');
    const [sourceErrors, setSourceErrors] = useState<Partial<Record<ConfigKind, string>>>({});
    const [loaded, setLoaded] = useState(false);
    const [saving, setSaving] = useState(false);
    const handledRequestId = useRef(0);

    const [state, dispatch] = useReducer(configReducer, initialConfigState);

    const load = useCallback((): void => {
        void Promise.all([
            caxri.request('settings.get'),
            caxri.request('keybindings.get'),
            caxri.request('theme.get'),
        ])
            .then(([settingsResult, keybindingsResult, themeResult]) => {
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
                setLoaded(true);
            })
            .catch((error: unknown) => onError(error, 'Unable to load configuration'));
    }, []);

    // Only load once per app session: reopening the dialog after edits must keep the
    // in-memory drafts instead of silently overwriting them with the on-disk versions.
    useEffect(() => {
        if (open && !loaded) load();
    }, [load, open, loaded]);

    const drafts: ConfigDrafts = useMemo(
        () => ({
            settings: {
                source: state.settings.source,
                appliedSource: state.settings.appliedSource,
            },
            keybindings: {
                source: state.keybindings.source,
                appliedSource: state.keybindings.appliedSource,
            },
            theme: { source: state.theme.source, appliedSource: state.theme.appliedSource },
        }),
        [state.settings, state.keybindings, state.theme],
    );
    const dirtyKinds = dirtyConfigKinds(drafts);
    const draftKeybindingConflicts = useMemo(() => {
        const parsed = parseConfigSource('keybindings', state.keybindings.source);
        return parsed.ok ? findKeybindingConflicts(parsed.value) : [];
    }, [state.keybindings.source]);

    const setSourceError = useCallback((kind: ConfigKind, error?: string): void => {
        setSourceErrors((current) => {
            if (current[kind] === error) return current;
            const next = { ...current };
            if (error) next[kind] = error;
            else delete next[kind];
            return next;
        });
    }, []);

    const synchronizeSource = useCallback(
        (kind: ConfigKind): boolean => {
            if (kind === 'settings') {
                const result = parseConfigSource('settings', state.settings.source);
                if (!result.ok) {
                    setSourceError(kind, result.error);
                    return false;
                }
                dispatch({ type: 'settings/sourceParsed', value: result.value });
            } else if (kind === 'keybindings') {
                const result = parseConfigSource('keybindings', state.keybindings.source);
                if (!result.ok) {
                    setSourceError(kind, result.error);
                    return false;
                }
                dispatch({ type: 'keybindings/sourceParsed', value: result.value });
            } else {
                const result = parseConfigSource('theme', state.theme.source);
                if (!result.ok) {
                    setSourceError(kind, result.error);
                    return false;
                }
                dispatch({ type: 'theme/sourceParsed', value: result.value });
            }
            setSourceError(kind);
            return true;
        },
        [setSourceError, state.keybindings.source, state.settings.source, state.theme.source],
    );

    useEffect(() => {
        if (!loaded || handledRequestId.current === request.id) return;
        let cancelled = false;
        /** Defer the local view transition and consume the request only after StrictMode cleanup. */
        queueMicrotask(() => {
            if (cancelled || handledRequestId.current === request.id) return;
            handledRequestId.current = request.id;
            if (request.view === 'source') {
                if (view === 'source' && tab !== 'settings' && !synchronizeSource(tab)) return;
                setTab('settings');
                setView('source');
                return;
            }
            if (view === 'source' && !synchronizeSource(tab)) return;
            setView('ui');
        });
        return () => {
            cancelled = true;
        };
    }, [loaded, request.id, request.view, synchronizeSource, tab, view]);

    const changeTab = (next: ConfigKind): void => {
        if (next === tab) return;
        if (view === 'source' && !synchronizeSource(tab)) return;
        setTab(next);
    };

    const showUi = (): void => {
        if (!synchronizeSource(tab)) return;
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

    const applyAll = async (): Promise<void> => {
        if (saving || dirtyKinds.length === 0) return;
        setSaving(true);
        try {
            // The three config kinds are independent runtime operations, so apply them
            // concurrently instead of awaiting each one sequentially. Each kind catches
            // its own failure so one rejection never blocks the others from applying.
            const results = await Promise.all(
                dirtyKinds.map(async (kind): Promise<string | null> => {
                    try {
                        if (kind === 'settings') {
                            const result = await caxri.request('settings.update', {
                                source: state.settings.source,
                            });
                            dispatch({
                                type: 'settings/applied',
                                value: result.value,
                                source: result.source,
                            });
                        } else if (kind === 'keybindings') {
                            const result = await caxri.request('keybindings.update', {
                                source: state.keybindings.source,
                            });
                            dispatch({
                                type: 'keybindings/applied',
                                value: result.value,
                                source: result.source,
                                conflicts: result.conflicts,
                            });
                        } else {
                            const result = await caxri.request('theme.update', {
                                source: state.theme.source,
                            });
                            dispatch({
                                type: 'theme/applied',
                                value: result.value,
                                source: result.source,
                            });
                        }
                        return null;
                    } catch (error) {
                        const label = CONFIG_FILE_NAMES[kind];
                        return `${label} — ${describeFailure(error, label)}`;
                    }
                }),
            );
            const failures = results.filter((failure): failure is string => failure !== null);
            if (failures.length < dirtyKinds.length) onApplied();
            if (failures.length > 0) pushToast('error', failures.join('; '));
        } finally {
            setSaving(false);
        }
    };

    const updateSettingsField = <K extends keyof AppSettings>(
        key: K,
        value: AppSettings[K],
    ): void => {
        if (!state.settings.value) return;
        dispatch({
            type: 'settings/changed',
            value: { ...state.settings.value, [key]: value },
            source: applyFormEdit(state.settings.source, [key], value),
        });
    };

    const updateBinding = (index: number, key: string): void => {
        dispatch({
            type: 'keybindings/changed',
            value: state.keybindings.value.map((binding, at) =>
                at === index ? { ...binding, key } : binding,
            ),
            source: updateKeybindingSource(state.keybindings.source, index, key),
        });
    };

    const addBinding = (command: string, key: string): void => {
        const binding: Keybinding = { command, key };
        dispatch({
            type: 'keybindings/changed',
            value: [...state.keybindings.value, binding],
            source: appendKeybindingSource(
                state.keybindings.source,
                state.keybindings.value.length,
                binding,
            ),
        });
    };

    const removeBinding = (index: number): void => {
        dispatch({
            type: 'keybindings/changed',
            value: state.keybindings.value.filter((_, at) => at !== index),
            source: removeKeybindingSource(state.keybindings.source, index),
        });
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
    };

    const importTheme = async (): Promise<void> => {
        try {
            const imported = await caxri.request('theme.import');
            if (!imported) return;
            // The importer writes theme.json directly, so re-read only the theme tab
            // instead of a full `load()` that would discard drafts on the other tabs.
            const result = await caxri.request('theme.get');
            dispatch({ type: 'theme/imported', value: result.value, source: result.source });
            onApplied();
        } catch (error) {
            onError(error, 'Theme import failed');
        }
    };

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="grid h-[min(760px,calc(100vh-48px))] w-[min(920px,calc(100vw-48px))] grid-rows-[auto_auto_minmax(0,1fr)_auto] overflow-hidden">
                <DialogHeader>
                    <DialogTitle>Settings</DialogTitle>
                    <DialogDescription>
                        Edit structured values or their source, then apply them together.
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
                            content: (
                                <>
                                    <span data-slot="chrome-tab-label">
                                        {value[0].toUpperCase() + value.slice(1)}
                                    </span>
                                    {isConfigDirty(drafts[value]) && (
                                        <span
                                            aria-hidden="true"
                                            className="text-warning"
                                            data-dirty="true"
                                        >
                                            •
                                        </span>
                                    )}
                                </>
                            ),
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
                                onChange={(source) => updateSource('settings', source)}
                            />
                        ) : (
                            <SettingsForm
                                settings={state.settings.value}
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
                                onChange={(source) => updateSource('keybindings', source)}
                            />
                        ) : (
                            <KeybindingsForm
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

                <footer
                    className={cn(
                        'dialog-actions',
                        'flex justify-end gap-2 border-t border-border px-3 py-2',
                    )}
                >
                    <Button
                        variant="ghost"
                        onClick={() => void caxri.request('app.openConfigFile', { kind: tab })}
                    >
                        <FileJson size={14} /> Open Config File
                    </Button>
                    <Button
                        disabled={
                            saving ||
                            dirtyKinds.length === 0 ||
                            dirtyKinds.some((kind) => sourceErrors[kind] !== undefined) ||
                            (dirtyKinds.includes('keybindings') &&
                                draftKeybindingConflicts.length > 0)
                        }
                        onClick={() => void applyAll()}
                    >
                        <Save size={14} /> Apply
                    </Button>
                </footer>
            </DialogContent>
        </Dialog>
    );
}
