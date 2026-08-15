import { agentProviderCatalog, type AgentProvider } from '@shared/agents';
import type {
    AgentHookHealthMap,
    AgentSkillHealth,
    AgentSkillInstallationHealth,
    AgentSkillScope,
    AppSettings,
} from '@shared/types';

import { AgentIdentityIcon } from '../../icons/agents/agent-identity-icon';
import { Input } from '../../components/ui/input';
import { Textarea } from '../../components/ui/textarea';

interface AgentProviderSettingsProps {
    agentHookHealth?: AgentHookHealthMap;
    agentSkillHealth?: AgentSkillHealth;
    provider: AgentProvider;
    providerSettings: AppSettings['agents.providers'][AgentProvider];
    onChange: (settings: AppSettings['agents.providers'][AgentProvider]) => void;
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

/**
 * Plain-language health caption for a provider's lifecycle-hook adapter. DESIGN.md principle 3
 * forbids implementation vocabulary like "drifted" or "awaiting first trusted event". Every state
 * the user cannot resolve just by waiting pairs with the concrete next step described above the
 * checkbox: restart the provider's Agent Terminals.
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

/** Provider-specific lifecycle, messaging, skill-health, and launch controls. */
export function AgentProviderSettings({
    agentHookHealth,
    agentSkillHealth,
    provider,
    providerSettings,
    onChange,
}: AgentProviderSettingsProps) {
    const launch = providerSettings.launch;
    const providerName = agentProviderCatalog[provider].displayName;
    const updateLaunch = (
        next: Partial<AppSettings['agents.providers'][typeof provider]['launch']>,
    ): void => onChange({ ...providerSettings, launch: { ...launch, ...next } });
    const updateHooks = (enabled: boolean): void =>
        onChange({ ...providerSettings, hooks: { enabled } });
    const updateMessaging = (enabled: boolean): void =>
        onChange({ ...providerSettings, messaging: { enabled } });

    return (
        <section
            data-agent-provider={provider}
            className="mb-3 rounded-md bg-[color-mix(in_srgb,var(--elevated)_55%,transparent)] p-3"
        >
            <h3 className="mb-3 flex items-center gap-2 font-medium text-foreground">
                <AgentIdentityIcon identity={provider} size={16} />
                {providerName}
            </h3>
            <label className="mb-3 flex items-start justify-between gap-4 text-[11px] text-muted">
                <span>
                    Lifecycle hooks
                    <span className="block max-w-xl">
                        Keeps background Session unread state accurate. Caxri only receives
                        lifecycle phases, never prompt or response content. Restart Agent Terminals
                        opened before lifecycle hooks were enabled.
                    </span>
                    <span className="mt-1 block" role="status">
                        {hookHealthLabel(
                            providerSettings.hooks.enabled,
                            agentHookHealth?.[provider],
                        )}
                    </span>
                </span>
                <input
                    aria-label={`${providerName} lifecycle hooks`}
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
                        Lets this managed Agent exchange bounded peer text through the Caxri Inbox.
                        It never pastes messages into the Terminal. Disabling takes effect
                        immediately without stopping the Terminal; restart only if the CLI adapter
                        is unavailable.
                    </span>
                </span>
                <input
                    aria-label={`${providerName} peer messaging`}
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
                    const installation = skillScopeHealth(agentSkillHealth, provider, scope);
                    return (
                        <div
                            key={scope}
                            data-agent-skill-scope={scope}
                            className="mt-2 border-t border-border pt-2"
                        >
                            <span className="block text-foreground">
                                {skillScopeSummary(agentSkillHealth, installation, scope)}
                            </span>
                            {installation && (
                                <span className="mt-0.5 block">{installation.action}</span>
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
                    aria-label={`${providerName} executable`}
                    value={launch.executable}
                    onChange={(event) => updateLaunch({ executable: event.target.value })}
                />
            </label>
            <label className="block text-[11px] text-muted">
                Initial arguments, one per line
                <Textarea
                    className="mt-1 bg-background text-foreground"
                    aria-label={`${providerName} initial arguments`}
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
}
