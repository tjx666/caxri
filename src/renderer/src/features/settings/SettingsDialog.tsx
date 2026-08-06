import { parse } from 'jsonc-parser';
import { FileJson, Save } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';

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
import { setSettingsOpen, useDialogStore } from '../../state/dialogs';
import { describeFailure, pushToast } from '../../state/toasts';
import { refreshWorkbench } from '../../state/workbench';
import {
    applyFormEdit,
    CONFIG_FILE_NAMES,
    CONFIG_KINDS,
    dirtyConfigKinds,
    isConfigDirty,
    type ConfigDrafts,
    type ConfigKind,
} from './configEdit';
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

export function SettingsDialog() {
    const open = useDialogStore((state) => state.settingsOpen);
    const onOpenChange = setSettingsOpen;
    const [tab, setTab] = useState<ConfigKind>('settings');
    const [loaded, setLoaded] = useState(false);
    const [saving, setSaving] = useState(false);

    const [settings, setSettings] = useState<AppSettings>();
    const [settingsSource, setSettingsSource] = useState('');
    const [settingsAppliedSource, setSettingsAppliedSource] = useState('');

    const [keybindings, setKeybindings] = useState<Keybinding[]>([]);
    const [keybindingsSource, setKeybindingsSource] = useState('');
    const [keybindingsAppliedSource, setKeybindingsAppliedSource] = useState('');
    const [conflicts, setConflicts] = useState<KeybindingConflict[]>([]);

    const [theme, setTheme] = useState<ThemeTokens>();
    const [themeSource, setThemeSource] = useState('');
    const [themeAppliedSource, setThemeAppliedSource] = useState('');

    const load = useCallback((): void => {
        void Promise.all([
            caxri.request('settings.get'),
            caxri.request('keybindings.get'),
            caxri.request('theme.get'),
        ])
            .then(([settingsResult, keybindingsResult, themeResult]) => {
                setSettings(settingsResult.value);
                setSettingsSource(settingsResult.source);
                setSettingsAppliedSource(settingsResult.source);
                setKeybindings(keybindingsResult.value);
                setKeybindingsSource(keybindingsResult.source);
                setKeybindingsAppliedSource(keybindingsResult.source);
                setConflicts(keybindingsResult.conflicts);
                setTheme(themeResult.value);
                setThemeSource(themeResult.source);
                setThemeAppliedSource(themeResult.source);
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
            settings: { source: settingsSource, appliedSource: settingsAppliedSource },
            keybindings: { source: keybindingsSource, appliedSource: keybindingsAppliedSource },
            theme: { source: themeSource, appliedSource: themeAppliedSource },
        }),
        [
            settingsSource,
            settingsAppliedSource,
            keybindingsSource,
            keybindingsAppliedSource,
            themeSource,
            themeAppliedSource,
        ],
    );
    const dirtyKinds = dirtyConfigKinds(drafts);

    const applyAll = async (): Promise<void> => {
        if (saving || dirtyKinds.length === 0) return;
        setSaving(true);
        const failures: string[] = [];
        try {
            for (const kind of dirtyKinds) {
                try {
                    if (kind === 'settings') {
                        const result = await caxri.request('settings.update', {
                            source: settingsSource,
                        });
                        setSettings(result.value);
                        setSettingsSource(result.source);
                        setSettingsAppliedSource(result.source);
                    } else if (kind === 'keybindings') {
                        const result = await caxri.request('keybindings.update', {
                            source: keybindingsSource,
                        });
                        setKeybindings(result.value);
                        setKeybindingsSource(result.source);
                        setKeybindingsAppliedSource(result.source);
                        setConflicts(result.conflicts);
                    } else {
                        const result = await caxri.request('theme.update', { source: themeSource });
                        setTheme(result.value);
                        setThemeSource(result.source);
                        setThemeAppliedSource(result.source);
                    }
                } catch (error) {
                    const label = CONFIG_FILE_NAMES[kind];
                    failures.push(`${label} — ${describeFailure(error, label)}`);
                }
            }
        } finally {
            setSaving(false);
        }
        if (failures.length < dirtyKinds.length) onApplied();
        if (failures.length > 0) pushToast('error', failures.join('; '));
    };

    const updateSettingsField = <K extends keyof AppSettings>(
        key: K,
        value: AppSettings[K],
    ): void => {
        if (!settings) return;
        setSettings({ ...settings, [key]: value });
        setSettingsSource((current) => applyFormEdit(current, [key], value));
    };

    const updateBinding = (index: number, field: 'key' | 'command', value: string): void => {
        setKeybindings((current) =>
            current.map((binding, at) => (at === index ? { ...binding, [field]: value } : binding)),
        );
        setKeybindingsSource((current) => applyFormEdit(current, [index, field], value));
    };

    const updateThemeColor = (
        section: 'colors' | 'terminal' | 'editor',
        key: string,
        value: string,
    ): void => {
        if (!theme) return;
        const wasDracula = theme.id === 'dracula';
        const nextId = wasDracula ? 'custom-dracula' : theme.id;
        setTheme({
            ...theme,
            id: nextId,
            source: 'custom',
            [section]: { ...theme[section], [key]: value },
        });
        setThemeSource((current) => {
            let next = applyFormEdit(current, [section, key], value);
            next = applyFormEdit(next, ['source'], 'custom');
            if (wasDracula) next = applyFormEdit(next, ['id'], nextId);
            return next;
        });
    };

    const updateThemeSource = (source: string): void => {
        setThemeSource(source);
        try {
            const next = parseThemeSource(source);
            if (next) setTheme(next);
        } catch {
            // Keep the last valid preview while the user is editing incomplete JSON.
        }
    };

    const importTheme = async (): Promise<void> => {
        try {
            const imported = await caxri.request('theme.import');
            if (!imported) return;
            // The importer writes theme.json directly, so re-read only the theme tab
            // instead of a full `load()` that would discard drafts on the other tabs.
            const result = await caxri.request('theme.get');
            setTheme(result.value);
            setThemeSource(result.source);
            setThemeAppliedSource(result.source);
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

                {tab === 'settings' && settings && theme && (
                    <SettingsForm
                        settings={settings}
                        source={settingsSource}
                        theme={theme}
                        onFieldChange={updateSettingsField}
                        onSourceChange={setSettingsSource}
                    />
                )}

                {tab === 'keybindings' && theme && (
                    <KeybindingsForm
                        keybindings={keybindings}
                        conflicts={conflicts}
                        source={keybindingsSource}
                        theme={theme}
                        onFieldChange={updateBinding}
                        onSourceChange={setKeybindingsSource}
                    />
                )}

                {tab === 'theme' && theme && (
                    <ThemeForm
                        theme={theme}
                        source={themeSource}
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
