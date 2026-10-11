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
 * pairs with a concrete next step: restarting the provider's Agent Terminals, or, for `conflict`, the fix its message
 * names.
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
                // `AgentHookManager.reconcileNow()` appends `health.message`: "Install the {CLI} CLI, then restart
                // Caxri.", whenever an install hint exists (the common case), so this base label states only the
                // status and leaves the specific instruction to that message (DESIGN.md principle 6, "say each
                // meaning once"; same fix already applied to the `drifted` case in `hookHealthFor`). Without a
                // message (e.g. another profile owns install authority), this label alone still reads correctly.
                return 'Not in effect';
            case 'installedPending':
                return 'Not in effect until your next Agent session';
            case 'incompatible':
                return 'Newer installation is incomplete';
            case 'active':
                return 'Active';
            case 'stale':
                return 'Out of date — restart Agent Terminals to update it';
            case 'drifted':
                return 'Changed outside Caxri — restart Agent Terminals to reapply it';
            case 'conflict':
                // The cause is in the user's own configuration (a hook policy, foreign inline hooks, a symlink to a
                // missing file) and `health.message` names it and the fix, so no restart advice here: restarting
                // cannot resolve it, and once it is resolved the row moves on to "Not in effect until your next Agent
                // session", which carries that step.
                return 'Blocked by your configuration';
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
        case 'incompatible':
        case 'stale':
        case 'drifted':
            return 'warning';
        case 'conflict':
        case 'error':
            return 'danger';
        case 'notInstalled':
        case 'unsupported':
        case 'installedPending':
        case 'active':
            return 'muted';
    }
}

/**
 * Whether flipping this toggle can achieve anything. A platform that cannot run the adapter at all is the only state
 * where the answer is no; a missing CLI is a prerequisite the user can still go and satisfy, so the preference stays
 * theirs to record. The switch renders its real availability rather than a stored `true` the platform will never honor:
 * a control that reads "on" beside a caption saying it cannot work is the contradiction this resolves.
 */
export function isHookAdapterAvailable(
    health: AgentHookHealthMap[AgentProvider] | undefined,
): boolean {
    return health?.kind !== 'unsupported';
}

/**
 * Tone for one bundled-skill installation line. `missing` and `stale` both have a repair command right under them, so
 * they read as warnings; a conflicting installation is somebody else's file in our place, which the user has to resolve
 * before anything works.
 */
export function skillScopeTone(
    installation: AgentSkillInstallationHealth | undefined,
): 'danger' | 'neutral' | 'warning' {
    switch (installation?.status) {
        case 'conflict':
            return 'danger';
        case 'missing':
        case 'stale':
            return 'warning';
        default:
            return 'neutral';
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
