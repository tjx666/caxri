import type { AgentProvider } from '@caxri/protocol';
import { agentProviderIds } from '@caxri/protocol';

import type { AgentDelegationServiceOptions } from '../service-options';

/**
 * The Agents a fresh retry of a task that failed on `failed` may switch to: installed, not at their weekly usage guard,
 * and not the failed one. The order is the static provider order (Claude Code, Codex, then the others), so a Client
 * lists them the same way every time. A Server composed without the installation probe offers none.
 */
export async function retrySwitchTargets(
    options: Pick<AgentDelegationServiceOptions, 'isProviderInstalled' | 'isProviderGuarded'>,
    failed: AgentProvider,
): Promise<AgentProvider[]> {
    const { isProviderInstalled, isProviderGuarded } = options;
    if (!isProviderInstalled) return [];
    const candidates = agentProviderIds.filter(
        (provider) => provider !== failed && !isProviderGuarded?.(provider),
    );
    const installed = await Promise.all(
        candidates.map(async (provider) => {
            try {
                return await isProviderInstalled(provider);
            } catch {
                return false;
            }
        }),
    );
    return candidates.filter((_, index) => installed[index]);
}
