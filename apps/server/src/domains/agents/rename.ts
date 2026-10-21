import type { AgentProvider } from '@caxri/protocol';
import { agentProviderCatalog, CaxriError, isCaxriError } from '@caxri/protocol';
import { coerce, gte } from 'semver';

import { agentProcessEnvironment } from '../executables';
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
 * Gives provider subprocesses the same environment as a launched Agent (the user's interactive login-shell variables
 * under Caxri's allowlisted launch context) while honoring test, portable, and custom Agent homes supplied through the
 * Agent integration seam.
 *
 * The login-shell PATH is part of that environment, not an extra. A GUI-launched Server Core inherits macOS's launchd
 * PATH (`/usr/bin:/bin:/usr/sbin:/sbin`), and several Agent CLIs (`codex` among them) are installed as `/bin/sh` shims
 * that `exec node`. Handing such a shim the launchd PATH makes it exit 127 within milliseconds, which surfaced as an
 * unexplained "could not rename the Agent session".
 */
export async function agentCommandEnvironment(
    environment: AgentEnvironment,
): Promise<NodeJS.ProcessEnv> {
    return {
        ...(await agentProcessEnvironment(environment.variables)),
        HOME: environment.homeDirectory,
    };
}

const RENAME_FAILURE_DETAIL_MAX_LENGTH = 300;

/**
 * Extracts the CLI's own account for a rejected rename, so "not logged in" or "rate limited" is visible instead of only
 * the generic fallback below (issue caxri#1345). `execFileAsync`'s documented `promisify` special case attaches
 * `stderr` to the rejected `Error`, which is the CLI's actual complaint; `message` is Node's own "Command failed: …"
 * wrapper around it and is used only when the CLI produced no stderr (e.g. a spawn-level failure). Bounded so a
 * pathological CLI cannot inflate the rename toast or its log record.
 */
function renameFailureDetail(error: unknown): string | undefined {
    if (!(error instanceof Error)) return undefined;
    const stderr = (error as Error & { stderr?: unknown }).stderr;
    const detail = (typeof stderr === 'string' ? stderr : '').trim() || error.message.trim();
    if (!detail) return undefined;
    return detail.length > RENAME_FAILURE_DETAIL_MAX_LENGTH
        ? `${detail.slice(0, RENAME_FAILURE_DETAIL_MAX_LENGTH)}…`
        : detail;
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
    const detail = renameFailureDetail(error);
    throw new CaxriError(
        'UNAVAILABLE',
        `${agentProviderCatalog[provider].displayName} could not rename the Agent session${detail ? `: ${detail}` : ''}`,
    );
}
