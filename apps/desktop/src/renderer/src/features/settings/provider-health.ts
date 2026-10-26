import type {
    AgentHookHealthMap,
    AgentProvider,
    AgentSkillHealth,
    AgentSkillInstallationHealth,
    AgentSkillScope,
} from '@caxri/protocol';

import type { Translate } from '../../i18n';

/**
 * Plain-language health caption for a provider's lifecycle-hook adapter. DESIGN.md principle 3 forbids implementation
 * vocabulary like "drifted" or "awaiting first trusted event". Every state the user cannot resolve just by waiting
 * pairs with a concrete next step: restarting the provider's Agent Terminals, or, for `conflict`, the fix its message
 * names.
 */
export function hookHealthLabel(
    t: Translate,
    isEnabled: boolean,
    health: AgentHookHealthMap[AgentProvider] | undefined,
): string {
    if (!isEnabled) return t('settings.providerHealth.hook.disabled');
    if (!health) return t('settings.providerHealth.hook.checking');
    const label = (() => {
        switch (health.kind) {
            case 'unsupported':
                return t('settings.providerHealth.hook.unsupported');
            case 'notInstalled':
                // `AgentHookManager.reconcileNow()` appends `health.message`: "Install {Claude Code|the Codex CLI}, then restart
                // Caxri.", whenever an install hint exists (the common case), so this base label states only the
                // status and leaves the specific instruction to that message (DESIGN.md principle 6, "say each
                // meaning once"; same fix already applied to the `drifted` case in `hookHealthFor`). Without a
                // message (e.g. another profile owns install authority), this label alone still reads correctly.
                return t('settings.providerHealth.hook.notInstalled');
            case 'installedPending':
                return t('settings.providerHealth.hook.installedPending');
            case 'incompatible':
                return t('settings.providerHealth.hook.incompatible');
            case 'active':
                return t('settings.providerHealth.hook.active');
            case 'stale':
                return t('settings.providerHealth.hook.stale');
            case 'drifted':
                return t('settings.providerHealth.hook.drifted');
            case 'conflict':
                // The cause is in the user's own configuration (a hook policy, foreign inline hooks, a symlink to a
                // missing file) and `health.message` names it and the fix, so no restart advice here: restarting
                // cannot resolve it, and once it is resolved the row moves on to "Not in effect until your next Agent
                // session", which carries that step.
                return t('settings.providerHealth.hook.conflict');
            case 'error':
                return t('settings.providerHealth.hook.error');
        }
    })();
    return health.message
        ? t('settings.providerHealth.hook.withMessage', { label, message: health.message })
        : label;
}

/**
 * The caption under a lifecycle-hook switch. Labelled, because a bare `Active` under the switch did not say what was
 * active.
 */
export function hookHealthCaption(
    t: Translate,
    isEnabled: boolean,
    health: AgentHookHealthMap[AgentProvider] | undefined,
): string {
    return t('settings.providerHealth.hook.caption', {
        label: hookHealthLabel(t, isEnabled, health),
    });
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
 * Tone for one bundled-skill installation line. The skill is optional, so a `missing` one is muted information with its
 * install command beneath, not a warning; a `stale` one is installed but out of date and does warn; a conflicting
 * installation is somebody else's file in our place, which the user has to resolve before anything works.
 */
export function skillScopeTone(
    installation: AgentSkillInstallationHealth | undefined,
): 'danger' | 'muted' | 'neutral' | 'warning' {
    switch (installation?.status) {
        case 'conflict':
            return 'danger';
        case 'stale':
            return 'warning';
        case 'missing':
            return 'muted';
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
    t: Translate,
    health: AgentSkillHealth | undefined,
    installation: AgentSkillInstallationHealth | undefined,
    scope: AgentSkillScope,
): string {
    const parameters = { scope: t(`settings.providerHealth.skill.scope.${scope}`) };
    if (!health) return t('settings.providerHealth.skill.checking', parameters);
    if (scope === 'local' && !health.selectedProjectId)
        return t('settings.providerHealth.skill.selectProject', parameters);
    if (!installation) return t('settings.providerHealth.skill.uninspectable', parameters);
    // `Missing · not installed` said one thing twice.
    if (installation.status === 'missing' || !installation.installedVersion)
        return t('settings.providerHealth.skill.notInstalled', parameters);
    return t('settings.providerHealth.skill.installed', {
        ...parameters,
        status: t(`settings.providerHealth.skill.status.${installation.status}`),
        version: installation.installedVersion,
    });
}
