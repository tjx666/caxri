import { parse } from 'jsonc-parser';
import { FileJson, Save } from 'lucide-react';
import { useCallback, useEffect, useMemo, useReducer, useState } from 'react';

import type { AppSettings, Keybinding, KeybindingConflict, ThemeTokens } from '@shared/types';

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
import { KeybindingsForm } from './KeybindingsForm';
import { SettingsForm } from './SettingsForm';
import { ThemeForm } from './ThemeForm';

const onApplied = (): void => void refreshWorkbench();
const onError = (error: unknown, label: string): void =>
    pushToast('error', describeFailure(error, label));

function parseThemeSource(source: string): ThemeTokens | undefined {
    const value = parse(source) as Partial<ThemeTokens> | undefined;
    if (
        !value ||
        typeof value !== 'object' ||
        !value.colors ||
        !value.terminal ||
        !value.editor ||
        !Array.isArray(value.warnings)
    ) {
        return undefined;
    }
    return value as ThemeTokens;
}

/**
 * The three config kinds share the same value/source/appliedSource shape (plus
 * keybinding conflicts), so they are consolidated into one `useReducer` instead of
 * ~12 independent `useState` calls. Grouping them keeps a load/apply/import from
 * ever leaving one kind's value, draft source, and applied source out of sync.
 */
interface ConfigState {
    settings: { value: AppSettings | undefined; source: string; appliedSource: string };
    keybindings: {
        value: Keybinding[];
        source: string;
        appliedSource: string;
        conflicts: KeybindingConflict[];
    };
    theme: { value: ThemeTokens | undefined; source: string; appliedSource: string };
}

const initialConfigState: ConfigState = {
    settings: { value: undefined, source: '', appliedSource: '' },
    keybindings: { value: [], source: '', appliedSource: '', conflicts: [] },
    theme: { value: undefined, source: '', appliedSource: '' },
};

type ConfigAction =
    | {
          type: 'loaded';
          settings: { value: AppSettings; source: string };
          keybindings: { value: Keybinding[]; source: string; conflicts: KeybindingConflict[] };
          theme: { value: ThemeTokens; source: string };
      }
    | { type: 'settings/changed'; value: AppSettings; source: string }
    | { type: 'settings/sourceChanged'; source: string }
    | { type: 'settings/applied'; value: AppSettings; source: string }
    | { type: 'keybindings/changed'; value: Keybinding[]; source: string }
    | { type: 'keybindings/sourceChanged'; source: string }
    | {
          type: 'keybindings/applied';
          value: Keybinding[];
          source: string;
          conflicts: KeybindingConflict[];
      }
    | { type: 'theme/changed'; value: ThemeTokens; source: string }
    | { type: 'theme/sourceChanged'; source: string; value?: ThemeTokens }
    | { type: 'theme/applied'; value: ThemeTokens; source: string }
    | { type: 'theme/imported'; value: ThemeTokens; source: string };

function configReducer(state: ConfigState, action: ConfigAction): ConfigState {
    switch (action.type) {
        case 'loaded':
            return {
                settings: {
                    value: action.settings.value,
                    source: action.settings.source,
                    appliedSource: action.settings.source,
                },
                keybindings: {
                    value: action.keybindings.value,
                    source: action.keybindings.source,
                    appliedSource: action.keybindings.source,
                    conflicts: action.keybindings.conflicts,
                },
                theme: {
                    value: action.theme.value,
                    source: action.theme.source,
                    appliedSource: action.theme.source,
                },
            };
        case 'settings/changed':
            return {
                ...state,
                settings: { ...state.settings, value: action.value, source: action.source },
            };
        case 'settings/sourceChanged':
            return { ...state, settings: { ...state.settings, source: action.source } };
        case 'settings/applied':
            return {
                ...state,
                settings: {
                    value: action.value,
                    source: action.source,
                    appliedSource: action.source,
                },
            };
        case 'keybindings/changed':
            return {
                ...state,
                keybindings: { ...state.keybindings, value: action.value, source: action.source },
            };
        case 'keybindings/sourceChanged':
            return { ...state, keybindings: { ...state.keybindings, source: action.source } };
        case 'keybindings/applied':
            return {
                ...state,
                keybindings: {
                    value: action.value,
                    source: action.source,
                    appliedSource: action.source,
                    conflicts: action.conflicts,
                },
            };
        case 'theme/changed':
            return {
                ...state,
                theme: { ...state.theme, value: action.value, source: action.source },
            };
        case 'theme/sourceChanged':
            return {
                ...state,
                theme: {
                    ...state.theme,
                    source: action.source,
                    value: action.value ?? state.theme.value,
                },
            };
        case 'theme/applied':
            return {
                ...state,
                theme: { value: action.value, source: action.source, appliedSource: action.source },
            };
        case 'theme/imported':
            return {
                ...state,
                theme: {
                    value: action.value,
                    source: action.source,
                    appliedSource: action.source,
                },
            };
        default:
            return state;
    }
}

export function SettingsDialog() {
    const open = useDialogStore((state) => state.settingsOpen);
    const onOpenChange = setSettingsOpen;
    const [tab, setTab] = useState<ConfigKind>('settings');
    const [loaded, setLoaded] = useState(false);
    const [saving, setSaving] = useState(false);

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

    const updateSettingsSource = (source: string): void => {
        dispatch({ type: 'settings/sourceChanged', source });
    };

    const updateBinding = (index: number, field: 'key' | 'command', value: string): void => {
        dispatch({
            type: 'keybindings/changed',
            value: state.keybindings.value.map((binding, at) =>
                at === index ? { ...binding, [field]: value } : binding,
            ),
            source: applyFormEdit(state.keybindings.source, [index, field], value),
        });
    };

    const updateKeybindingsSource = (source: string): void => {
        dispatch({ type: 'keybindings/sourceChanged', source });
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

    const updateThemeSource = (source: string): void => {
        let value: ThemeTokens | undefined;
        try {
            value = parseThemeSource(source);
        } catch {
            // Keep the last valid preview while the user is editing incomplete JSON.
        }
        dispatch({ type: 'theme/sourceChanged', source, value });
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
                        Changes apply immediately and are stored as editable files.
                    </DialogDescription>
                </DialogHeader>
                <div className="flex border-b border-border">
                    {CONFIG_KINDS.map((value) => (
                        <button
                            key={value}
                            className={cn(
                                'min-h-9 cursor-pointer border-0 border-b-2 border-transparent bg-surface px-4 text-muted hover:text-foreground',
                                tab === value && 'border-b-indicator text-foreground',
                            )}
                            onClick={() => setTab(value)}
                        >
                            {value[0].toUpperCase() + value.slice(1)}
                            {isConfigDirty(drafts[value]) && (
                                <span className="text-warning" aria-hidden="true">
                                    {' '}
                                    •
                                </span>
                            )}
                        </button>
                    ))}
                </div>

                {tab === 'settings' && state.settings.value && state.theme.value && (
                    <SettingsForm
                        settings={state.settings.value}
                        source={state.settings.source}
                        theme={state.theme.value}
                        onFieldChange={updateSettingsField}
                        onSourceChange={updateSettingsSource}
                    />
                )}

                {tab === 'keybindings' && state.theme.value && (
                    <KeybindingsForm
                        keybindings={state.keybindings.value}
                        conflicts={state.keybindings.conflicts}
                        source={state.keybindings.source}
                        theme={state.theme.value}
                        onFieldChange={updateBinding}
                        onSourceChange={updateKeybindingsSource}
                    />
                )}

                {tab === 'theme' && state.theme.value && (
                    <ThemeForm
                        theme={state.theme.value}
                        source={state.theme.source}
                        onColorChange={updateThemeColor}
                        onSourceChange={updateThemeSource}
                        onImport={() => void importTheme()}
                    />
                )}

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
                        <FileJson size={14} /> Open File
                    </Button>
                    <Button
                        disabled={saving || dirtyKinds.length === 0}
                        onClick={() => void applyAll()}
                    >
                        <Save size={14} /> Apply
                    </Button>
                </footer>
            </DialogContent>
        </Dialog>
    );
}
