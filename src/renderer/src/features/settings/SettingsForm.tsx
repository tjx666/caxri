import { Suspense, lazy } from 'react';

import { agentProviderCatalog, agentProviderIds } from '@shared/agents';
import type { AppSettings, ThemeTokens } from '@shared/types';

import { AgentIdentityIcon } from '../../icons/agents/AgentIdentityIcon';
import { Input } from '../../components/ui/input';
import { Textarea } from '../../components/ui/textarea';
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
import { bytesToMebibytes, mebibytesToBytes } from './config-edit';

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
            <div className="structured-editor min-h-0 overflow-auto border-r border-border p-4">
                <div className={cn(settingsFieldRowClassName, 'min-h-9 gap-4')}>
                    <label htmlFor="default-agent">Default agent for new sessions</label>
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
                            className="w-44 flex-none bg-background"
                        >
                            <SelectValue>
                                <span className="flex items-center gap-2">
                                    <AgentIdentityIcon
                                        identity={settings['session.defaultAgent']}
                                        size={14}
                                    />
                                    {defaultAgentLabel(settings['session.defaultAgent'])}
                                </span>
                            </SelectValue>
                        </SelectTrigger>
                        <SelectContent>
                            <SelectItem value="ask">
                                <span className="flex items-center gap-2">
                                    <AgentIdentityIcon identity={null} size={14} /> Ask each time
                                </span>
                            </SelectItem>
                            {agentProviderIds.map((provider) => (
                                <SelectItem key={provider} value={provider}>
                                    <span className="flex items-center gap-2">
                                        <AgentIdentityIcon identity={provider} size={14} />
                                        {agentProviderCatalog[provider].displayName}
                                    </span>
                                </SelectItem>
                            ))}
                            <SelectItem value="shell">
                                <span className="flex items-center gap-2">
                                    <AgentIdentityIcon identity="shell" size={14} /> Shell
                                </span>
                            </SelectItem>
                        </SelectContent>
                    </Select>
                </div>
                <label className={cn(settingsFieldRowClassName, 'min-h-9 gap-4')}>
                    <span>Terminal font size</span>
                    <span className="relative w-40 flex-none">
                        <Input
                            className="bg-background pr-8"
                            type="number"
                            min={9}
                            max={32}
                            value={settings['terminal.fontSize']}
                            onChange={(event) =>
                                onFieldChange('terminal.fontSize', Number(event.target.value))
                            }
                        />
                        <span className="pointer-events-none absolute top-1/2 right-2 -translate-y-1/2 text-[11px] text-muted">
                            px
                        </span>
                    </span>
                </label>
                <label className={cn(settingsFieldRowClassName, 'min-h-9 gap-4')}>
                    <span>Terminal scrollback lines</span>
                    <span className="relative w-40 flex-none">
                        <Input
                            className="bg-background pr-12"
                            type="number"
                            min={100}
                            max={10000}
                            value={settings['terminal.scrollback']}
                            onChange={(event) =>
                                onFieldChange('terminal.scrollback', Number(event.target.value))
                            }
                        />
                        <span className="pointer-events-none absolute top-1/2 right-2 -translate-y-1/2 text-[11px] text-muted">
                            lines
                        </span>
                    </span>
                </label>
                <label className="mb-4 block text-foreground">
                    <span>
                        New Terminal working directory
                        <span className="block text-[11px] text-muted">
                            Leave empty to use the Project root
                        </span>
                    </span>
                    <Input
                        className="mt-2 bg-background"
                        placeholder="Project root"
                        value={settings['terminal.defaultWorkingDirectory'] ?? ''}
                        onChange={(event) =>
                            onFieldChange(
                                'terminal.defaultWorkingDirectory',
                                event.target.value || null,
                            )
                        }
                    />
                </label>
                <label className={cn(settingsFieldRowClassName, 'min-h-9 gap-4')}>
                    <span>Maximum editable file size</span>
                    <span className="relative w-40 flex-none">
                        <Input
                            className="bg-background pr-8"
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
                        <span className="pointer-events-none absolute top-1/2 right-2 -translate-y-1/2 text-[11px] text-muted">
                            MB
                        </span>
                    </span>
                </label>
                {agentProviderIds.map((provider) => {
                    const launch = settings['agents.providers'][provider].launch;
                    const updateLaunch = (
                        next: Partial<AppSettings['agents.providers'][typeof provider]['launch']>,
                    ): void =>
                        onFieldChange('agents.providers', {
                            ...settings['agents.providers'],
                            [provider]: { launch: { ...launch, ...next } },
                        });
                    return (
                        <section
                            key={provider}
                            data-agent-provider={provider}
                            className="mb-3 rounded-md bg-[color-mix(in_srgb,var(--elevated)_55%,transparent)] p-3"
                        >
                            <h3 className="mb-3 flex items-center gap-2 font-medium text-foreground">
                                <AgentIdentityIcon identity={provider} size={16} />
                                {agentProviderCatalog[provider].displayName}
                            </h3>
                            <label className="mb-2 block text-[11px] text-muted">
                                Executable
                                <Input
                                    className="mt-1 bg-background text-foreground"
                                    aria-label={`${agentProviderCatalog[provider].displayName} executable`}
                                    value={launch.executable}
                                    onChange={(event) =>
                                        updateLaunch({ executable: event.target.value })
                                    }
                                />
                            </label>
                            <label className="block text-[11px] text-muted">
                                Initial arguments, one per line
                                <Textarea
                                    className="mt-1 bg-background text-foreground"
                                    aria-label={`${agentProviderCatalog[provider].displayName} initial arguments`}
                                    value={launch.args.join('\n')}
                                    onChange={(event) =>
                                        updateLaunch({
                                            args: event.target.value
                                                .split('\n')
                                                .filter((argument) => argument.length > 0),
                                        })
                                    }
                                />
                            </label>
                        </section>
                    );
                })}
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
