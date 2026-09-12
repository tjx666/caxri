import type { AgentHookHealth, AgentHookHealthMap } from '@caxri/protocol';
import { agentProviderIds } from '@caxri/protocol';

import type { AgentHookEntryStatus } from './contract';

export function defaultHookHealth(message?: string): AgentHookHealthMap {
    return Object.fromEntries(
        agentProviderIds.map((provider) => [
            provider,
            { kind: 'notInstalled', ...(message && { message }) },
        ]),
    ) as AgentHookHealthMap;
}

/**
 * Maps one provider's inspected file status onto the health a user can act on. It lives beside `AgentHookManager`
 * rather than inside it so that module stays within the repository's file-size budget.
 */
export function hookHealthFor(
    status: AgentHookEntryStatus,
    isActive: boolean,
    currentSchema: number,
): AgentHookHealth {
    /**
     * A newer build remains usable only when it covers this build's required bindings. Its file ordering token does not
     * replace launch-environment schema negotiation, and this build must never repair a newer file (issue #557).
     */
    if (status.kind === 'newerIncomplete')
        return {
            kind: 'incompatible',
            installedSchema: status.installedSchema,
            message:
                'Required lifecycle bindings are missing. Update Caxri or repair hooks with the newer build.',
        };
    if (status.kind === 'current' || status.kind === 'newer')
        return isActive
            ? {
                  kind: 'active',
                  installedSchema: status.kind === 'newer' ? status.installedSchema : currentSchema,
              }
            : {
                  kind: 'installedPending',
                  installedSchema: status.kind === 'newer' ? status.installedSchema : currentSchema,
                  message: 'Installed. Review and trust the hook in the Agent CLI if prompted.',
              };
    if (status.kind === 'absent') return { kind: 'notInstalled' };
    if (status.kind === 'stale')
        return {
            kind: 'stale',
            installedSchema: status.installedSchema,
            message: `Installed hook schema ${status.installedSchema} needs an update.`,
        };
    if (status.kind === 'conflict') return { kind: 'conflict', message: status.message };
    if (status.kind === 'unparseable') return { kind: 'error', message: status.message };
    return { kind: 'drifted', message: 'Caxri hook entries were edited outside Caxri.' };
}
