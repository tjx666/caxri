import type { AgentProvider } from '@caxri/protocol';

import type { AgentDispatchServiceOptions, AgentDispatchStartOptions } from './service-options';

/**
 * Runs the composed `prepareLaunch` hook before a PTY Agent is created in `cwd`. Best effort by contract: a failing
 * hook leaves the Agent's own prompt in place and never fails the dispatch.
 */
export async function prepareLaunchBestEffort(
    serviceOptions: Pick<AgentDispatchServiceOptions, 'prepareLaunch'>,
    provider: AgentProvider,
    cwd: string,
    surface: AgentDispatchStartOptions['surface'],
): Promise<void> {
    // A Chat runs through the provider SDK, which has no folder trust prompt.
    if (surface === 'chat') return;
    try {
        await serviceOptions.prepareLaunch?.(provider, cwd);
    } catch {
        // The Agent then shows its own prompt.
    }
}
