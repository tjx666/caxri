import { parse } from 'jsonc-parser';
import { FileJson, Import, Save } from 'lucide-react';
import { lazy, Suspense, useCallback, useEffect, useState } from 'react';

import type { AppSettings, Keybinding, KeybindingConflict, ThemeTokens } from '@shared/types';

import { AgentIdentityIcon } from '../agent-icons/AgentIdentityIcon';
import { ThemePreview } from './ThemePreview';
import { Button } from './ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from './ui/dialog';
import { Input } from './ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select';

const ConfigurationEditor = lazy(() => import('./ConfigurationEditor'));

type ConfigKind = 'settings' | 'keybindings' | 'theme';

interface SettingsDialogProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    onApplied: () => void;
    onError: (message: string) => void;
}

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

function defaultAgentLabel(agent: AppSettings['session.defaultAgent']): string {
    if (agent === 'claude') return 'Claude Code';
    if (agent === 'codex') return 'Codex';
    if (agent === 'shell') return 'Shell';
    return 'Ask when creating a Session';
}

export function SettingsDialog({ open, onOpenChange, onApplied, onError }: SettingsDialogProps) {
    const [tab, setTab] = useState<ConfigKind>('settings');
    const [settings, setSettings] = useState<AppSettings>();
    const [settingsSource, setSettingsSource] = useState('');
    const [keybindings, setKeybindings] = useState<Keybinding[]>([]);
    const [keybindingsSource, setKeybindingsSource] = useState('');
    const [conflicts, setConflicts] = useState<KeybindingConflict[]>([]);
    const [theme, setTheme] = useState<ThemeTokens>();
    const [themeSource, setThemeSource] = useState('');

    const load = useCallback((): void => {
        void Promise.all([
            window.caxri.request<{ value: AppSettings; source: string }>('settings.get'),
            window.caxri.request<{
                value: Keybinding[];
                source: string;
                conflicts: KeybindingConflict[];
            }>('keybindings.get'),
            window.caxri.request<{ value: ThemeTokens; source: string }>('theme.get'),
        ])
            .then(([settingsResult, keybindingsResult, themeResult]) => {
                setSettings(settingsResult.value);
                setSettingsSource(settingsResult.source);
                setKeybindings(keybindingsResult.value);
                setKeybindingsSource(keybindingsResult.source);
                setConflicts(keybindingsResult.conflicts);
                setTheme(themeResult.value);
                setThemeSource(themeResult.source);
            })
            .catch((error: unknown) =>
                onError(error instanceof Error ? error.message : 'Unable to load configuration'),
            );
    }, [onError]);

    useEffect(() => {
        if (open) load();
    }, [load, open]);

    const apply = async (): Promise<void> => {
        try {
            if (tab === 'settings') {
                const result = await window.caxri.request<{ value: AppSettings; source: string }>(
                    'settings.update',
                    { source: settingsSource },
                );
                setSettings(result.value);
                setSettingsSource(result.source);
            } else if (tab === 'keybindings') {
                const result = await window.caxri.request<{
                    value: Keybinding[];
                    source: string;
                    conflicts: KeybindingConflict[];
                }>('keybindings.update', { source: keybindingsSource });
                setKeybindings(result.value);
                setKeybindingsSource(result.source);
                setConflicts(result.conflicts);
            } else {
                const result = await window.caxri.request<{ value: ThemeTokens; source: string }>(
                    'theme.update',
                    { source: themeSource },
                );
                setTheme(result.value);
                setThemeSource(result.source);
            }
            onApplied();
        } catch (error) {
            onError(error instanceof Error ? error.message : 'Configuration update failed');
        }
    };

    const updateSettings = (patch: Partial<AppSettings>): void => {
        if (!settings) return;
        const value = { ...settings, ...patch };
        setSettings(value);
        setSettingsSource(`${JSON.stringify(value, null, 2)}\n`);
    };

    const updateBinding = (index: number, patch: Partial<Keybinding>): void => {
        const value = keybindings.map((binding, current) =>
            current === index ? { ...binding, ...patch } : binding,
        );
        setKeybindings(value);
        setKeybindingsSource(`${JSON.stringify(value, null, 2)}\n`);
    };

    const updateThemeColor = (
        section: 'colors' | 'terminal' | 'editor',
        key: string,
        value: string,
    ): void => {
        if (!theme) return;
        const next = structuredClone(theme);
        (next[section] as unknown as Record<string, string>)[key] = value;
        next.source = 'custom';
        next.id = next.id === 'dracula' ? 'custom-dracula' : next.id;
        setTheme(next);
        setThemeSource(`${JSON.stringify(next, null, 2)}\n`);
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
            const imported = await window.caxri.request<ThemeTokens | null>('theme.import');
            if (imported) {
                setTheme(imported);
                load();
                onApplied();
            }
        } catch (error) {
            onError(error instanceof Error ? error.message : 'Theme import failed');
        }
    };

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="settings-dialog">
                <DialogHeader>
                    <DialogTitle>Settings</DialogTitle>
                    <DialogDescription>
                        Global configuration uses validated files with hot reload and
                        last-known-good fallback.
                    </DialogDescription>
                </DialogHeader>
                <div className="settings-tabs">
                    {(['settings', 'keybindings', 'theme'] as const).map((value) => (
                        <button
                            key={value}
                            className={tab === value ? 'active' : ''}
                            onClick={() => setTab(value)}
                        >
                            {value[0].toUpperCase() + value.slice(1)}
                        </button>
                    ))}
                </div>

                {tab === 'settings' && settings && theme && (
                    <div className="settings-body">
                        <div className="structured-editor">
                            <div className="settings-field">
                                <label className="settings-field-title" htmlFor="default-agent">
                                    <AgentIdentityIcon
                                        identity={settings['session.defaultAgent']}
                                        size={14}
                                    />
                                    Default Agent
                                </label>
                                <Select
                                    value={settings['session.defaultAgent'] ?? 'ask'}
                                    onValueChange={(value) =>
                                        updateSettings({
                                            'session.defaultAgent': (value === 'ask'
                                                ? null
                                                : value) as AppSettings['session.defaultAgent'],
                                        })
                                    }
                                >
                                    <SelectTrigger id="default-agent" aria-label="Default Agent">
                                        <SelectValue>
                                            {defaultAgentLabel(settings['session.defaultAgent'])}
                                        </SelectValue>
                                    </SelectTrigger>
                                    <SelectContent>
                                        <SelectItem value="ask">
                                            Ask when creating a Session
                                        </SelectItem>
                                        <SelectItem value="claude">Claude Code</SelectItem>
                                        <SelectItem value="codex">Codex</SelectItem>
                                        <SelectItem value="shell">Shell</SelectItem>
                                    </SelectContent>
                                </Select>
                            </div>
                            <label className="settings-field">
                                <span>Terminal font size</span>
                                <Input
                                    type="number"
                                    min={9}
                                    max={32}
                                    value={settings['terminal.fontSize']}
                                    onChange={(event) =>
                                        updateSettings({
                                            'terminal.fontSize': Number(event.target.value),
                                        })
                                    }
                                />
                            </label>
                            <label className="settings-field">
                                <span>Terminal scrollback</span>
                                <Input
                                    type="number"
                                    min={100}
                                    max={10000}
                                    value={settings['terminal.scrollback']}
                                    onChange={(event) =>
                                        updateSettings({
                                            'terminal.scrollback': Number(event.target.value),
                                        })
                                    }
                                />
                            </label>
                            <label className="settings-field">
                                <span>Maximum file bytes</span>
                                <Input
                                    type="number"
                                    min={1024}
                                    max={16777216}
                                    value={settings['files.maxFileBytes']}
                                    onChange={(event) =>
                                        updateSettings({
                                            'files.maxFileBytes': Number(event.target.value),
                                        })
                                    }
                                />
                            </label>
                        </div>
                        <Suspense fallback={<div className="configuration-editor-loading" />}>
                            <ConfigurationEditor
                                ariaLabel="settings.jsonc source"
                                path="/caxri/settings.jsonc"
                                theme={theme}
                                value={settingsSource}
                                onChange={setSettingsSource}
                            />
                        </Suspense>
                    </div>
                )}

                {tab === 'keybindings' && theme && (
                    <div className="settings-body">
                        <div className="structured-editor bindings-editor">
                            {keybindings.map((binding, index) => (
                                <div key={`${binding.command}-${index}`} className="binding-row">
                                    <Input
                                        aria-label={`Shortcut for ${binding.command}`}
                                        value={binding.key}
                                        onChange={(event) =>
                                            updateBinding(index, { key: event.target.value })
                                        }
                                    />
                                    <Input
                                        aria-label="Command"
                                        value={binding.command}
                                        onChange={(event) =>
                                            updateBinding(index, { command: event.target.value })
                                        }
                                    />
                                </div>
                            ))}
                            {conflicts.length > 0 && (
                                <div className="config-error">
                                    {conflicts
                                        .map(
                                            (conflict) =>
                                                `${conflict.key}: ${conflict.commands.join(', ')}`,
                                        )
                                        .join('\n')}
                                </div>
                            )}
                        </div>
                        <Suspense fallback={<div className="configuration-editor-loading" />}>
                            <ConfigurationEditor
                                ariaLabel="keybindings.jsonc source"
                                path="/caxri/keybindings.jsonc"
                                theme={theme}
                                value={keybindingsSource}
                                onChange={setKeybindingsSource}
                            />
                        </Suspense>
                    </div>
                )}

                {tab === 'theme' && theme && (
                    <div className="settings-body">
                        <div className="structured-editor theme-editor">
                            <ThemePreview theme={theme} />
                            <div className="theme-name">
                                <strong>{theme.name}</strong>
                                <span>{theme.source}</span>
                            </div>
                            {(['colors', 'terminal', 'editor'] as const).map((section) => (
                                <fieldset key={section}>
                                    <legend>{section[0].toUpperCase() + section.slice(1)}</legend>
                                    {Object.entries(theme[section]).map(([key, value]) => (
                                        <label key={key}>
                                            {key}
                                            <span>
                                                <input
                                                    type="color"
                                                    value={value.slice(0, 7)}
                                                    onChange={(event) =>
                                                        updateThemeColor(
                                                            section,
                                                            key,
                                                            event.target.value,
                                                        )
                                                    }
                                                />
                                                <code>{value}</code>
                                            </span>
                                        </label>
                                    ))}
                                </fieldset>
                            ))}
                            {theme.warnings.map((warning) => (
                                <p key={warning} className="config-warning">
                                    {warning}
                                </p>
                            ))}
                            <Button
                                size="sm"
                                variant="secondary"
                                onClick={() => void importTheme()}
                            >
                                <Import size={13} /> Import Theme
                            </Button>
                        </div>
                        <Suspense fallback={<div className="configuration-editor-loading" />}>
                            <ConfigurationEditor
                                ariaLabel="theme.json source"
                                path="/caxri/theme.json"
                                theme={theme}
                                value={themeSource}
                                onChange={updateThemeSource}
                            />
                        </Suspense>
                    </div>
                )}

                <footer className="dialog-actions">
                    <Button
                        variant="ghost"
                        onClick={() =>
                            void window.caxri.request('app.openConfigFile', { kind: tab })
                        }
                    >
                        <FileJson size={14} /> Open File
                    </Button>
                    <Button onClick={() => void apply()}>
                        <Save size={14} /> Apply
                    </Button>
                </footer>
            </DialogContent>
        </Dialog>
    );
}
