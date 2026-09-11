import type { AgentProvider } from '@caxri/protocol';
import { agentProviderCatalog, CaxriError, isCaxriError } from '@caxri/protocol';
import { coerce, gte } from 'semver';

import { serverProcessEnvironment } from '../executables';
import type { AgentEnvironment } from './contract';

export function assertAgentRenameVersion(
    provider: AgentProvider,
    rawVersion: string,
    minimumVersion: string,
): void {
    const version = coerce(rawVersion);
    const minimum = coerce(minimumVersion);
    if (version && minimum && version.major === minimum.major && gte(version, minimum)) return;
    throw new CaxriError(
        'UNAVAILABLE',
        `${agentProviderCatalog[provider].displayName} ${minimumVersion}+ within major ${minimum?.major ?? 'unknown'} is required to rename Agent sessions`,
    );
}

/**
 * Keeps provider subprocesses on the same secret-minimized environment boundary as every other Server command while
 * honoring test, portable, and custom Agent homes supplied through the Agent integration seam.
 *
 * The login-shell PATH is part of that boundary, not an extra. A GUI-launched Server Core inherits macOS's launchd PATH
 * (`/usr/bin:/bin:/usr/sbin:/sbin`), and several Agent CLIs — `codex` among them — are installed as `/bin/sh` shims
 * that `exec node`. Handing such a shim the launchd PATH makes it exit 127 within milliseconds, which surfaced as an
 * unexplained "could not rename the Agent session".
 */
export async function agentCommandEnvironment(
    environment: AgentEnvironment,
): Promise<NodeJS.ProcessEnv> {
    return {
        ...(await serverProcessEnvironment(environment.variables)),
        HOME: environment.homeDirectory,
    };
}

export function throwAgentRenameError(
    provider: AgentProvider,
    error: unknown,
    signal?: AbortSignal,
): never {
    if (isCaxriError(error)) throw error;
    if (signal?.aborted)
        throw new CaxriError(
            'CANCELLED',
            `${agentProviderCatalog[provider].displayName} Session rename was cancelled`,
        );
    if (
        error instanceof Error &&
        'killed' in error &&
        (error as Error & { killed?: unknown }).killed === true
    )
        throw new CaxriError(
            'TIMEOUT',
            `${agentProviderCatalog[provider].displayName} Session rename timed out`,
        );
    throw new CaxriError(
        'UNAVAILABLE',
        `${agentProviderCatalog[provider].displayName} could not rename the Agent session`,
    );
}
