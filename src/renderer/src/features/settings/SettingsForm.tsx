import { Suspense, lazy } from 'react';

import { agentProviderCatalog, agentProviderIds } from '@shared/agents';
import type { AppSettings, ThemeTokens } from '@shared/types';

import { AgentIdentityIcon } from '../../icons/agents/AgentIdentityIcon';
import { Input } from '../../components/ui/input';
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from '../../components/ui/select';
import {
    cn,
    configurationEditorLoadingClassName,
    settingsFieldRowClassName,
} from '../../lib/utils';
import { bytesToMebibytes, formatByteHint, mebibytesToBytes } from './config-edit';

const ConfigurationEditor = lazy(async () => {
    const module = await import('./ConfigurationEditor');
    return { default: module.ConfigurationEditor };
});

interface SettingsFormProps {
    settings: AppSettings;
    source: string;
    theme: ThemeTokens;
    onFieldChange: <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => void;
    onSourceChange: (source: string) => void;
}

function defaultAgentLabel(agent: AppSettings['session.defaultAgent']): string {
    if (agent === 'shell') return 'Shell';
    if (agent && agent in agentProviderCatalog) return agentProviderCatalog[agent].displayName;
    return 'Ask each time';
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
        <div className="grid min-h-0 grid-cols-[minmax(250px,0.85fr)_minmax(310px,1.15fr)] overflow-hidden">
            <div className="structured-editor min-h-0 overflow-auto border-r border-border p-3">
                <div className={cn(settingsFieldRowClassName, 'min-h-9')}>
                    <label className="inline-flex items-center gap-2" htmlFor="default-agent">
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
                            className="w-40 flex-none"
                        >
                            <SelectValue>
                                {defaultAgentLabel(settings['session.defaultAgent'])}
                            </SelectValue>
                        </SelectTrigger>
                        <SelectContent>
                            <SelectItem value="ask">Ask each time</SelectItem>
                            {agentProviderIds.map((provider) => (
                                <SelectItem key={provider} value={provider}>
                                    {agentProviderCatalog[provider].displayName}
                                </SelectItem>
                            ))}
                            <SelectItem value="shell">Shell</SelectItem>
                        </SelectContent>
                    </Select>
                </div>
                <label className={cn(settingsFieldRowClassName, 'min-h-9')}>
                    <span>Terminal font size</span>
                    <Input
                        className="w-40 flex-none"
                        type="number"
                        min={9}
                        max={32}
                        value={settings['terminal.fontSize']}
                        onChange={(event) =>
                            onFieldChange('terminal.fontSize', Number(event.target.value))
                        }
                    />
                </label>
                <label className={cn(settingsFieldRowClassName, 'min-h-9')}>
                    <span>Terminal scrollback lines</span>
                    <Input
                        className="w-40 flex-none"
                        type="number"
                        min={100}
                        max={10000}
                        value={settings['terminal.scrollback']}
                        onChange={(event) =>
                            onFieldChange('terminal.scrollback', Number(event.target.value))
                        }
                    />
                </label>
                <label className={cn(settingsFieldRowClassName, 'min-h-9')}>
                    <span>
                        Maximum editable file size
                        <span className="block text-[11px] text-muted">
                            {formatByteHint(settings['files.maxFileBytes'])}
                        </span>
                    </span>
                    <Input
                        className="w-40 flex-none"
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
            <Suspense fallback={<div className={configurationEditorLoadingClassName} />}>
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
