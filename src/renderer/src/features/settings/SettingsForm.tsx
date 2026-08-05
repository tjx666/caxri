import { Suspense, lazy } from 'react';

import type { AppSettings, ThemeTokens } from '@shared/types';

import { AgentIdentityIcon } from '../../agent-icons/AgentIdentityIcon';
import { Input } from '../../components/ui/input';
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from '../../components/ui/select';
import { bytesToMebibytes, formatByteHint, mebibytesToBytes } from './configEdit';

const ConfigurationEditor = lazy(() => import('./ConfigurationEditor'));

interface SettingsFormProps {
    settings: AppSettings;
    source: string;
    theme: ThemeTokens;
    onFieldChange: <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => void;
    onSourceChange: (source: string) => void;
}

function defaultAgentLabel(agent: AppSettings['session.defaultAgent']): string {
    if (agent === 'claude') return 'Claude Code';
    if (agent === 'codex') return 'Codex';
    if (agent === 'shell') return 'Shell';
    return 'Ask when creating a Session';
}

/** The `settings` tab: structured fields on the left, the raw settings.jsonc source on the right. */
export function SettingsForm({
    settings,
    source,
    theme,
    onFieldChange,
    onSourceChange,
}: SettingsFormProps) {
    const maxFileMebibytes = bytesToMebibytes(settings['files.maxFileBytes']);

    return (
        <div className="settings-body">
            <div className="structured-editor">
                <div className="settings-field">
                    <label className="settings-field-title" htmlFor="default-agent">
                        <AgentIdentityIcon identity={settings['session.defaultAgent']} size={14} />
                        Default agent for new sessions
                    </label>
                    <Select
                        value={settings['session.defaultAgent'] ?? 'ask'}
                        onValueChange={(value) =>
                            onFieldChange(
                                'session.defaultAgent',
                                (value === 'ask'
                                    ? null
                                    : value) as AppSettings['session.defaultAgent'],
                            )
                        }
                    >
                        <SelectTrigger
                            id="default-agent"
                            aria-label="Default agent for new sessions"
                        >
                            <SelectValue>
                                {defaultAgentLabel(settings['session.defaultAgent'])}
                            </SelectValue>
                        </SelectTrigger>
                        <SelectContent>
                            <SelectItem value="ask">Ask when creating a Session</SelectItem>
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
                            onFieldChange('terminal.fontSize', Number(event.target.value))
                        }
                    />
                </label>
                <label className="settings-field">
                    <span>Terminal scrollback lines</span>
                    <Input
                        type="number"
                        min={100}
                        max={10000}
                        value={settings['terminal.scrollback']}
                        onChange={(event) =>
                            onFieldChange('terminal.scrollback', Number(event.target.value))
                        }
                    />
                </label>
                <label className="settings-field">
                    <span>
                        Maximum editable file size
                        <span className="settings-field-hint">
                            {formatByteHint(settings['files.maxFileBytes'])}
                        </span>
                    </span>
                    <Input
                        type="number"
                        min={0.001}
                        max={16}
                        step={0.5}
                        value={maxFileMebibytes}
                        onChange={(event) =>
                            onFieldChange(
                                'files.maxFileBytes',
                                mebibytesToBytes(Number(event.target.value)),
                            )
                        }
                    />
                </label>
            </div>
            <Suspense fallback={<div className="configuration-editor-loading" />}>
                <ConfigurationEditor
                    ariaLabel="settings.jsonc source"
                    path="/caxri/settings.jsonc"
                    theme={theme}
                    value={source}
                    onChange={onSourceChange}
                />
            </Suspense>
        </div>
    );
}
