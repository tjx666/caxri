import { agentProviderCatalog, agentProviderIds } from '@shared/agents';
import type { AgentHookHealthMap, AgentSkillHealth, AppSettings } from '@shared/types';

import { AgentIdentityIcon } from '../../icons/agents/AgentIdentityIcon';
import { Input } from '../../components/ui/input';
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from '../../components/ui/select';
import { cn, settingsFieldRowClassName } from '../../lib/utils';
import { bytesToMebibytes, mebibytesToBytes } from './config-edit';
import { AgentProviderSettings } from './AgentProviderSettings';
import { TrustedDomainsForm } from './TrustedDomainsForm';

interface SettingsFormProps {
    agentHookHealth?: AgentHookHealthMap;
    agentSkillHealth?: AgentSkillHealth;
    trustedDomainsFocusRequestId?: number;
    settings: AppSettings;
    onFieldChange: <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => void;
}

function defaultAgentLabel(agent: AppSettings['session.defaultAgent']): string {
    if (agent === 'shell') return 'Shell';
    if (agent && agent in agentProviderCatalog) return agentProviderCatalog[agent].displayName;
    return 'Ask each time';
}

const NEW_WORKTREE_BEHAVIOR_LABELS: Record<AppSettings['workbench.newWorktreeBehavior'], string> = {
    ask: 'Ask',
    continueWhenAuthorized: 'Continue when authorized',
    ignore: 'Ignore',
};

/** Full-width structured editor for `settings.jsonc`. */
export function SettingsForm({
    agentHookHealth,
    agentSkillHealth,
    trustedDomainsFocusRequestId,
    settings,
    onFieldChange,
}: SettingsFormProps) {
    const maxFileMebibytes = bytesToMebibytes(settings['files.maxFileBytes']);

    return (
        <div className="min-h-0 overflow-hidden">
            <div className="structured-editor h-full min-h-0 overflow-auto p-4">
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
                <div className={cn(settingsFieldRowClassName, 'min-h-9 gap-4')}>
                    <label htmlFor="new-worktree-behavior">
                        New worktree behavior
                        <span className="block text-[11px] text-muted">
                            First access to a worktree always requires directory authorization
                        </span>
                    </label>
                    <Select
                        value={settings['workbench.newWorktreeBehavior']}
                        onValueChange={(value) =>
                            onFieldChange(
                                'workbench.newWorktreeBehavior',
                                value as AppSettings['workbench.newWorktreeBehavior'],
                            )
                        }
                    >
                        <SelectTrigger
                            id="new-worktree-behavior"
                            aria-label="New worktree behavior"
                            className="w-52 flex-none bg-background"
                        >
                            <SelectValue>
                                {
                                    NEW_WORKTREE_BEHAVIOR_LABELS[
                                        settings['workbench.newWorktreeBehavior']
                                    ]
                                }
                            </SelectValue>
                        </SelectTrigger>
                        <SelectContent>
                            <SelectItem value="ask">Ask</SelectItem>
                            <SelectItem value="continueWhenAuthorized">
                                Continue when authorized
                            </SelectItem>
                            <SelectItem value="ignore">Ignore</SelectItem>
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
                <div className={cn(settingsFieldRowClassName, 'min-h-9 gap-4')}>
                    <label htmlFor="terminal-gpu-acceleration">
                        Terminal GPU acceleration
                        <span className="block text-[11px] text-muted">
                            WebGL falls back to DOM rendering without restarting the Terminal
                        </span>
                    </label>
                    <Select
                        value={settings['terminal.gpuAcceleration']}
                        onValueChange={(value) =>
                            onFieldChange(
                                'terminal.gpuAcceleration',
                                value as AppSettings['terminal.gpuAcceleration'],
                            )
                        }
                    >
                        <SelectTrigger
                            id="terminal-gpu-acceleration"
                            aria-label="Terminal GPU acceleration"
                            className="w-40 flex-none bg-background"
                        >
                            <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                            <SelectItem value="auto">Auto</SelectItem>
                            <SelectItem value="on">On</SelectItem>
                            <SelectItem value="off">Off</SelectItem>
                        </SelectContent>
                    </Select>
                </div>
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
                <label className={cn(settingsFieldRowClassName, 'min-h-9 gap-4')}>
                    <span>
                        Copy on select
                        <span className="block text-[11px] text-muted">
                            Automatically copy Terminal selections to the clipboard
                        </span>
                    </span>
                    <input
                        aria-label="Copy on select"
                        checked={settings['terminal.copyOnSelect']}
                        className="size-4 flex-none accent-[var(--accent)]"
                        type="checkbox"
                        onChange={(event) =>
                            onFieldChange('terminal.copyOnSelect', event.target.checked)
                        }
                    />
                </label>
                <label className={cn(settingsFieldRowClassName, 'min-h-9 gap-4')}>
                    <span>
                        Allow OSC 52 clipboard writes
                        <span className="block text-[11px] text-muted">
                            Remote programs may request bounded writes; clipboard reads stay blocked
                        </span>
                    </span>
                    <input
                        aria-label="Allow OSC 52 clipboard writes"
                        checked={settings['terminal.osc52ClipboardWrite']}
                        className="size-4 flex-none accent-[var(--accent)]"
                        type="checkbox"
                        onChange={(event) =>
                            onFieldChange('terminal.osc52ClipboardWrite', event.target.checked)
                        }
                    />
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
                <TrustedDomainsForm
                    focusRequestId={trustedDomainsFocusRequestId}
                    rules={settings['security.trustedDomains']}
                    onChange={(rules) => onFieldChange('security.trustedDomains', rules)}
                />
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
                {agentProviderIds.map((provider) => (
                    <AgentProviderSettings
                        key={provider}
                        agentHookHealth={agentHookHealth}
                        agentSkillHealth={agentSkillHealth}
                        provider={provider}
                        providerSettings={settings['agents.providers'][provider]}
                        onChange={(providerSettings) =>
                            onFieldChange('agents.providers', {
                                ...settings['agents.providers'],
                                [provider]: providerSettings,
                            })
                        }
                    />
                ))}
            </div>
        </div>
    );
}
