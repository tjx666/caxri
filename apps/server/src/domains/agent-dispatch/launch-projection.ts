import { createHash } from 'node:crypto';

import type {
    AgentDispatchLaunch,
    AgentLaunchSettings,
    AgentProvider,
    Principal,
} from '@caxri/protocol';

/**
 * Durable idempotency key input: the same dispatch ID replayed with different command input must be rejected.
 */
export function dispatchFingerprint(
    principal: Principal,
    operation: string,
    input: unknown,
): string {
    return createHash('sha256')
        .update(JSON.stringify({ principal, operation, input }))
        .digest('hex');
}

function launchFingerprint(launch: AgentLaunchSettings): string {
    return createHash('sha256').update(JSON.stringify(launch)).digest('hex');
}

/**
 * The receipt's launch view. Argument values appear only inside the fingerprint hash, and provider resume arguments
 * only as a count.
 */
export function launchProjection(
    provider: AgentProvider,
    launch: AgentLaunchSettings,
    mode: AgentDispatchLaunch['mode'],
    resumeArgumentCount = 0,
): AgentDispatchLaunch {
    return {
        provider,
        mode,
        executable: launch.executable,
        argumentCount: launch.args.length + resumeArgumentCount,
        fingerprint: launchFingerprint({
            executable: launch.executable,
            args:
                resumeArgumentCount === 0
                    ? launch.args
                    : [...launch.args, `<${resumeArgumentCount} provider resume arguments>`],
        }),
    };
}
