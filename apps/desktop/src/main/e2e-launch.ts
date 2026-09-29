import type { E2EAgentPolicy } from '@caxri/system';

import type { E2EWindowMode } from './window-mode';

/**
 * Fields of the `e2e.launch` record, so a failed E2E run shows which Agent policy and window mode the launch used.
 */
export function e2eLaunchLogFields(
    policy: E2EAgentPolicy | undefined,
    windowMode: E2EWindowMode,
): Record<string, string | null> {
    return {
        agentMode: policy?.mode ?? 'blocked',
        agentProvider:
            policy?.mode === 'real'
                ? policy.provider
                : policy?.mode === 'fake'
                  ? Object.keys(policy.executables)
                        .toSorted((left, right) => left.localeCompare(right))
                        .join(',')
                  : null,
        windowMode,
    };
}
