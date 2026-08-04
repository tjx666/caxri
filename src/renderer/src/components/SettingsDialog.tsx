import { FileJson, Import, Save } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';

import type { AppSettings, Keybinding, KeybindingConflict, ThemeTokens } from '@shared/types';

import { AgentIdentityIcon } from '../agent-icons/AgentIdentityIcon';
import { Button } from './ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from './ui/dialog';

type ConfigKind = 'settings' | 'keybindings' | 'theme';

interface SettingsDialogProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    onApplied: () => void;
    onError: (message: string) => void;
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
                    {
                        source: settingsSource,
                    },
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
                    {
                        source: themeSource,
                    },
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

                {tab === 'settings' && settings && (
                    <div className="settings-body">
                        <div className="structured-editor">
                            <label>
                                <span className="settings-field-title">
                                    <AgentIdentityIcon
                                        identity={settings['session.defaultAgent']}
                                        size={14}
                                    />
                                    Default Agent
                                </span>
                                <select
                                    value={settings['session.defaultAgent'] ?? ''}
                                    onChange={(event) =>
                                        updateSettings({
                                            'session.defaultAgent': (event.target.value ||
                                                null) as AppSettings['session.defaultAgent'],
                                        })
                                    }
                                >
                                    <option value="">Ask when creating a Session</option>
                                    <option value="claude">Claude Code</option>
                                    <option value="codex">Codex</option>
                                    <option value="shell">Shell</option>
                                </select>
                            </label>
                            <label>
                                Terminal font size
                                <input
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
                            <label>
                                Terminal scrollback
                                <input
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
                            <label>
                                Maximum file bytes
                                <input
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
                        <textarea
                            aria-label="settings.jsonc source"
                            spellCheck={false}
                            value={settingsSource}
                            onChange={(event) => setSettingsSource(event.target.value)}
                        />
                    </div>
                )}

                {tab === 'keybindings' && (
                    <div className="settings-body">
                        <div className="structured-editor bindings-editor">
                            {keybindings.map((binding, index) => (
                                <div key={`${binding.command}-${index}`} className="binding-row">
                                    <input
                                        aria-label={`Shortcut for ${binding.command}`}
                                        value={binding.key}
                                        onChange={(event) =>
                                            updateBinding(index, { key: event.target.value })
                                        }
                                    />
                                    <input
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
                        <textarea
                            aria-label="keybindings.jsonc source"
                            spellCheck={false}
                            value={keybindingsSource}
                            onChange={(event) => setKeybindingsSource(event.target.value)}
                        />
                    </div>
                )}

                {tab === 'theme' && theme && (
                    <div className="settings-body">
                        <div className="structured-editor theme-editor">
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
                        <textarea
                            aria-label="theme.json source"
                            spellCheck={false}
                            value={themeSource}
                            onChange={(event) => setThemeSource(event.target.value)}
                        />
                    </div>
                )}

                <div className="dialog-actions">
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
                </div>
            </DialogContent>
        </Dialog>
    );
}
