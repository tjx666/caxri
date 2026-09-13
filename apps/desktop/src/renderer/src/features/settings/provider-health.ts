import type {
    AgentHookHealthMap,
    AgentProvider,
    AgentSkillHealth,
    AgentSkillInstallationHealth,
    AgentSkillScope,
} from '@caxri/protocol';

/**
 * Plain-language health caption for a provider's lifecycle-hook adapter. DESIGN.md principle 3 forbids implementation
 * vocabulary like "drifted" or "awaiting first trusted event". Every state the user cannot resolve just by waiting
 * pairs with the concrete next step described in the row description: restart the provider's Agent Terminals.
 */
export function hookHealthLabel(
    isEnabled: boolean,
    health: AgentHookHealthMap[AgentProvider] | undefined,
): string {
    if (!isEnabled) return 'Disabled';
    if (!health) return 'Checking installation…';
    const label = (() => {
        switch (health.kind) {
            case 'unsupported':
                return 'Not available on this platform';
            case 'notInstalled':
                return 'Waiting for the agent CLI to be installed';
            case 'installedPending':
                return 'Installed — activates once you start a session';
            case 'incompatible':
                return 'Newer installation is incomplete';
            case 'active':
                return 'Active';
            case 'stale':
                return 'Out of date — restart Agent Terminals to update it';
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

/**
 * Distinguishes states requiring intervention from healthy, disabled, and informational states.
 */
export function hookHealthTone(
    isEnabled: boolean,
    health: AgentHookHealthMap[AgentProvider] | undefined,
): 'danger' | 'muted' | 'warning' {
    if (!isEnabled || !health) return 'muted';
    switch (health.kind) {
        case 'notInstalled':
        case 'incompatible':
        case 'stale':
        case 'drifted':
            return 'warning';
        case 'conflict':
        case 'error':
            return 'danger';
        case 'unsupported':
        case 'installedPending':
        case 'active':
            return 'muted';
    }
}

export function skillScopeHealth(
    health: AgentSkillHealth | undefined,
    provider: AgentSkillInstallationHealth['provider'],
    scope: AgentSkillScope,
): AgentSkillInstallationHealth | undefined {
    return health?.installations.find(
        (installation) => installation.provider === provider && installation.scope === scope,
    );
}

export function skillScopeSummary(
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
