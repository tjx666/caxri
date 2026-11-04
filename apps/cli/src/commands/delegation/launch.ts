import { spawn } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import { constants } from 'node:os';
import { basename, resolve as resolvePath, sep } from 'node:path';
import process from 'node:process';

import type { AgentProvider, MethodResult } from '@caxri/protocol';
import { agentProviderIds, CaxriError, delegationProviderSchema } from '@caxri/protocol';

import {
    DELEGATION_PROJECT_ENVIRONMENT,
    DELEGATION_SESSION_ENVIRONMENT,
} from '../../delegation-environment';
import type { RemoteCommandRunContext } from '../types';

export interface DelegationLaunchParameters {
    command: [string, ...string[]];
    provider: AgentProvider;
    root?: string;
    ttlMs?: number;
}

const LAUNCH_FLAGS = new Set(['--root', '--provider', '--ttl-ms']);

/**
 * The provider is read from the executable only when its basename is exactly a provider id, so a wrapper script or a
 * renamed binary can never be guessed into the wrong identity. Anything else needs `--provider`.
 */
function providerFromExecutable(file: string): AgentProvider | undefined {
    const name = basename(file);
    return (agentProviderIds as readonly string[]).includes(name)
        ? (name as AgentProvider)
        : undefined;
}

export function launchParameters(tokens: readonly string[]): DelegationLaunchParameters {
    const separator = tokens.indexOf('--');
    const options = separator === -1 ? tokens : tokens.slice(0, separator);
    const command = separator === -1 ? [] : tokens.slice(separator + 1);
    if (command.length === 0)
        throw new CaxriError(
            'VALIDATION',
            'access launch requires -- <command> [args...], for example: -- claude',
        );
    const values = new Map<string, string>();
    for (let index = 0; index < options.length; index += 2) {
        const flag = options[index];
        const value = options[index + 1];
        if (!value || !LAUNCH_FLAGS.has(flag) || value.startsWith('--') || values.has(flag))
            throw new CaxriError('VALIDATION', 'Invalid or repeated access launch option');
        values.set(flag, value);
    }
    const explicit = values.get('--provider');
    const provider = explicit
        ? delegationProviderSchema.parse(explicit)
        : providerFromExecutable(command[0]);
    if (!provider)
        throw new CaxriError(
            'VALIDATION',
            `Cannot tell which Agent ${basename(command[0])} is; pass --provider <${agentProviderIds.join('|')}>`,
        );
    const ttl = values.get('--ttl-ms');
    if (ttl !== undefined && !/^\d+$/u.test(ttl))
        throw new CaxriError('VALIDATION', '--ttl-ms must be an integer of milliseconds');
    return {
        command: command as [string, ...string[]],
        provider,
        ...(values.has('--root') && { root: values.get('--root') }),
        ...(ttl !== undefined && { ttlMs: Number(ttl) }),
    };
}

async function canonical(path: string): Promise<string> {
    try {
        return await realpath(path);
    } catch {
        return resolvePath(path);
    }
}

/**
 * `--root` wins. Otherwise the root of the top-level Project that contains the working directory, so launching from a
 * subfolder authorizes the Project the user already added; a directory outside every Project is its own root.
 */
async function resolveRoot(context: RemoteCommandRunContext, explicit?: string): Promise<string> {
    if (explicit) return canonical(resolvePath(context.cwd, explicit));
    const cwd = await canonical(context.cwd);
    const { projects } = (await context.request(
        'project.list',
        {},
    )) as MethodResult<'project.list'>;
    const topLevel = projects.flatMap((project) =>
        'rootPath' in project && !('ownerProjectId' in project && project.ownerProjectId)
            ? [{ rootPath: project.rootPath }]
            : [],
    );
    const roots = await Promise.all(topLevel.map((project) => canonical(project.rootPath)));
    let best: string | undefined;
    let bestCanonical = '';
    for (const [index, project] of topLevel.entries()) {
        const root = roots[index] ?? '';
        const isInside =
            cwd === root || cwd.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);
        if (isInside && root.length > bestCanonical.length) {
            best = project.rootPath;
            bestCanonical = root;
        }
    }
    return best ?? cwd;
}

/**
 * Credentials and hints that belong to a previous launch or a managed Endpoint never reach the launched Agent.
 */
function launchEnvironment(
    base: NodeJS.ProcessEnv,
    profilePath: string,
    grant: MethodResult<'agent.delegation.access.create'>,
): NodeJS.ProcessEnv {
    const kept = Object.fromEntries(
        Object.entries(base).filter(
            ([name]) =>
                !name.startsWith('CAXRI_AGENT_ENDPOINT_') && !name.startsWith('CAXRI_DELEGATION_'),
        ),
    );
    return {
        ...kept,
        CAXRI_USER_DATA_DIR: profilePath,
        CAXRI_DELEGATION_CLIENT_ID: grant.clientId,
        CAXRI_DELEGATION_GENERATION: String(grant.generation),
        CAXRI_DELEGATION_TOKEN: grant.token,
        [DELEGATION_PROJECT_ENVIRONMENT]: grant.projectId,
        [DELEGATION_SESSION_ENVIRONMENT]: grant.sessionId,
    };
}

/**
 * Runs the Agent until it exits and reports its status as the launcher's own: a signal death becomes `128 + signal`.
 *
 * Ctrl-C reaches the Agent through the Terminal's process group, so SIGINT is not forwarded (forwarding would deliver
 * it twice and make an Agent that quits on a double Ctrl-C exit early); `holdSignals` swallows it. SIGTERM and SIGHUP
 * are sent to this process alone, so they are forwarded and the Agent never outlives the credential's revocation.
 */
function runAgent(
    command: readonly [string, ...string[]],
    environment: NodeJS.ProcessEnv,
    cwd: string,
): Promise<number> {
    const [file, ...arguments_] = command;
    return new Promise((resolve, reject) => {
        const child = spawn(file, arguments_, { cwd, env: environment, stdio: 'inherit' });
        const forwarded = ['SIGTERM', 'SIGHUP'] as const;
        const forward = (signal: NodeJS.Signals): void => {
            child.kill(signal);
        };
        for (const signal of forwarded) process.on(signal, forward);
        const cleanup = (): void => {
            for (const signal of forwarded) process.removeListener(signal, forward);
        };
        child.once('error', (error: NodeJS.ErrnoException) => {
            cleanup();
            reject(
                error.code === 'ENOENT'
                    ? new CaxriError('NOT_FOUND', `Command not found: ${file}`)
                    : new CaxriError('IO', `Could not start ${file}: ${error.code ?? 'unknown'}`),
            );
        });
        child.once('exit', (code, signal) => {
            cleanup();
            resolve(signal ? 128 + constants.signals[signal] : (code ?? 1));
        });
    });
}

/**
 * Installs no-op SIGINT, SIGTERM and SIGHUP handlers so the default action (process death) cannot skip the revocation,
 * and returns the function that removes them. The caller releases them only after the revoke request settled: a signal
 * that arrives after the Agent exited but while the revoke is still in flight would otherwise kill this process and
 * leave the credential valid until its TTL.
 */
function holdSignals(): () => void {
    const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;
    const hold = (): void => {};
    for (const signal of signals) process.on(signal, hold);
    return () => {
        for (const signal of signals) process.removeListener(signal, hold);
    };
}

/**
 * Issues a fresh delegation-client credential for the Agent, runs it, and revokes that exact generation on every way
 * out that the process survives: normal exit, a non-zero exit, a spawn failure, an interrupt before the Agent started,
 * and SIGTERM or SIGHUP. The revocation goes out before the owner connection closes (`settlesBeforeClose`). SIGKILL
 * cannot be handled, so the credential then lives until its TTL. The token is only ever placed in the child's
 * environment; it is never printed.
 */
export async function runDelegationLaunch(context: RemoteCommandRunContext): Promise<number> {
    const parameters = context.parameters as DelegationLaunchParameters;
    const root = await resolveRoot(context, parameters.root);
    const grant = (await context.request('agent.delegation.access.create', {
        rootPath: root,
        callerProvider: parameters.provider,
        registerProject: true,
        ...(parameters.ttlMs !== undefined && { ttlMs: parameters.ttlMs }),
    })) as MethodResult<'agent.delegation.access.create'>;
    const releaseSignals = holdSignals();
    try {
        if (context.signal?.aborted) return 130;
        return await runAgent(
            parameters.command,
            launchEnvironment(context.environment, context.profilePath, grant),
            context.cwd,
        );
    } finally {
        try {
            await context.request('agent.delegation.access.revoke', {
                clientId: grant.clientId,
                generation: grant.generation,
            });
        } catch {
            context.writeStderr(
                `Warning: could not revoke delegation client ${grant.clientId} generation ${grant.generation}; it stays valid until it expires. Run: caxri agent delegate access revoke --client ${grant.clientId} --generation ${grant.generation}\n`,
            );
        } finally {
            releaseSignals();
        }
    }
}
