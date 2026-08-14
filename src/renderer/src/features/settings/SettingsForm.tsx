import { agentProviderCatalog, agentProviderIds } from '@shared/agents';
import type {
    AgentHookHealthMap,
    AgentSkillHealth,
    AgentSkillInstallationHealth,
    AgentSkillScope,
    AppSettings,
} from '@shared/types';

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
import { cn, settingsFieldRowClassName } from '../../lib/utils';
import { bytesToMebibytes, mebibytesToBytes } from './config-edit';
import { TrustedDomainsForm } from './TrustedDomainsForm';

interface SettingsFormProps {
    agentHookHealth?: AgentHookHealthMap;
    agentSkillHealth?: AgentSkillHealth;
    trustedDomainsFocusRequestId?: number;
    settings: AppSettings;
    onFieldChange: <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => void;
}

function skillScopeHealth(
    health: AgentSkillHealth | undefined,
    provider: AgentSkillInstallationHealth['provider'],
    scope: AgentSkillScope,
): AgentSkillInstallationHealth | undefined {
    return health?.installations.find(
        (installation) => installation.provider === provider && installation.scope === scope,
    );
}

function skillScopeSummary(
    health: AgentSkillHealth | undefined,
    installation: AgentSkillInstallationHealth | undefined,
    scope: AgentSkillScope,
): string {
    const label = scope === 'local' ? 'Project local' : 'Global';
    if (!health) return `${label} · Checking installation…`;
    if (scope === 'local' && !health.selectedProjectId)
        return `${label} · Select a Project to inspect`;
    if (!installation) return `${label} · Unable to inspect this location`;
    const status = installation.status[0].toUpperCase() + installation.status.slice(1);
    return `${label} · ${status} · ${installation.installedVersion ? `installed v${installation.installedVersion}` : 'not installed'}`;
}

function defaultAgentLabel(agent: AppSettings['session.defaultAgent']): string {
    if (agent === 'shell') return 'Shell';
    if (agent && agent in agentProviderCatalog) return agentProviderCatalog[agent].displayName;
    return 'Ask each time';
}

/**
 * Plain-language health caption for a provider's lifecycle-hook adapter (DESIGN.md principle 3
 * forbids implementation vocabulary like "drifted" or "awaiting first trusted event"). Every state
 * the user cannot resolve just by waiting pairs with the same concrete next step already described
 * above the checkbox: restart the provider's Agent Terminals.
 */
function hookHealthLabel(
    enabled: boolean,
    health: AgentHookHealthMap['codex'] | undefined,
): string {
    if (!enabled) return 'Disabled';
    if (!health) return 'Checking installation…';
    const label = (() => {
        switch (health.kind) {
            case 'unsupported':
                return 'Not available on this platform';
            case 'notInstalled':
                return 'Waiting for the agent CLI to be installed';
            case 'installedPending':
                return 'Installed — activates once you start a session';
            case 'active':
                return 'Active';
            case 'stale':
                return 'Out of date — restart Agent Terminals to update it';
            case 'newer':
                return 'Managed by a newer version of Caxri';
            case 'drifted':
                return 'Changed outside Caxri — restart Agent Terminals to reapply it';
            case 'conflict':
                return 'Conflicts with another tool — restart Agent Terminals after resolving it';
            case 'error':
                return 'Setup failed — restart Agent Terminals to try again';
        }
    })();
    return health.message ? `${label} — ${health.message}` : label;
}

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
                {agentProviderIds.map((provider) => {
                    const providerSettings = settings['agents.providers'][provider];
                    const launch = providerSettings.launch;
                    const updateLaunch = (
                        next: Partial<AppSettings['agents.providers'][typeof provider]['launch']>,
                    ): void =>
                        onFieldChange('agents.providers', {
                            ...settings['agents.providers'],
                            [provider]: {
                                ...providerSettings,
                                launch: { ...launch, ...next },
                            },
                        });
                    const updateHooks = (enabled: boolean): void =>
                        onFieldChange('agents.providers', {
                            ...settings['agents.providers'],
                            [provider]: {
                                ...providerSettings,
                                hooks: { enabled },
                            },
                        });
                    const updateMessaging = (enabled: boolean): void =>
                        onFieldChange('agents.providers', {
                            ...settings['agents.providers'],
                            [provider]: {
                                ...providerSettings,
                                messaging: { enabled },
                            },
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
                            <label className="mb-3 flex items-start justify-between gap-4 text-[11px] text-muted">
                                <span>
                                    Lifecycle hooks
                                    <span className="block max-w-xl">
                                        Keeps background Session unread state accurate. Caxri only
                                        receives lifecycle phases, never prompt or response content.
                                        Restart Agent Terminals opened before lifecycle hooks were
                                        enabled.
                                    </span>
                                    <span className="mt-1 block" role="status">
                                        {hookHealthLabel(
                                            providerSettings.hooks.enabled,
                                            agentHookHealth?.[provider],
                                        )}
                                    </span>
                                </span>
                                <input
                                    aria-label={`${agentProviderCatalog[provider].displayName} lifecycle hooks`}
                                    checked={providerSettings.hooks.enabled}
                                    className="mt-0.5 size-4 flex-none accent-[var(--accent)]"
                                    type="checkbox"
                                    onChange={(event) => updateHooks(event.target.checked)}
                                />
                            </label>
                            <label className="mb-3 flex items-start justify-between gap-4 text-[11px] text-muted">
                                <span>
                                    Peer messaging
                                    <span className="block max-w-xl">
                                        Lets this managed Agent exchange bounded peer text through
                                        the Caxri Inbox. It never pastes messages into the Terminal.
                                        Disabling takes effect immediately without stopping the
                                        Terminal; restart only if the CLI adapter is unavailable.
                                    </span>
                                </span>
                                <input
                                    aria-label={`${agentProviderCatalog[provider].displayName} peer messaging`}
                                    checked={providerSettings.messaging.enabled}
                                    className="mt-0.5 size-4 flex-none accent-[var(--accent)]"
                                    type="checkbox"
                                    onChange={(event) => updateMessaging(event.target.checked)}
                                />
                            </label>
                            <div
                                data-agent-skill-health={provider}
                                className="mb-3 rounded-sm border border-border p-2 text-[11px] text-muted"
                            >
                                <span className="flex items-center justify-between gap-3 text-foreground">
                                    <span>Caxri CLI skill</span>
                                    <span className="font-mono text-[10px] text-muted">
                                        {agentSkillHealth
                                            ? `Bundled v${agentSkillHealth.bundled.bundledVersion}`
                                            : 'Checking bundle…'}
                                    </span>
                                </span>
                                {(['local', 'global'] as const).map((scope) => {
                                    const installation = skillScopeHealth(
                                        agentSkillHealth,
                                        provider,
                                        scope,
                                    );
                                    return (
                                        <div
                                            key={scope}
                                            data-agent-skill-scope={scope}
                                            className="mt-2 border-t border-border pt-2"
                                        >
                                            <span className="block text-foreground">
                                                {skillScopeSummary(
                                                    agentSkillHealth,
                                                    installation,
                                                    scope,
                                                )}
                                            </span>
                                            {installation && (
                                                <span className="mt-0.5 block">
                                                    {installation.action}
                                                </span>
                                            )}
                                            {installation?.repairCommand && (
                                                <code className="mt-1 block overflow-x-auto font-mono text-[10px] text-foreground">
                                                    {installation.repairCommand}
                                                </code>
                                            )}
                                        </div>
                                    );
                                })}
                            </div>
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
        </div>
    );
}
