import { createHash } from 'node:crypto';
import { lstat, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { AgentLaunchSettings, AgentProvider } from '@caxri/protocol';
import { CaxriError } from '@caxri/protocol';

import { delegationAdapter } from '../agents';

/**
 * Delegations own native session identity and interactive submission. An ambiguous positional argument or caller-owned
 * session flag must fail before a Terminal or task file is created.
 */
export function validateDelegationLaunch(
    provider: AgentProvider,
    launch: AgentLaunchSettings,
): void {
    delegationAdapter(provider).validateLaunch(launch);
}

async function privateDirectory(path: string): Promise<void> {
    try {
        await mkdir(path, { mode: 0o700 });
    } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    const info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0)
        throw new CaxriError('FORBIDDEN', 'Delegation storage must be a private directory');
}

/**
 * A running native session already trusts only its original task directory. Follow-ups stay inside that exact grant;
 * each exclusive file and pointer carries a fresh task identity without replacing an earlier task body.
 */
export async function prepareDelegationFollowUp(
    userDataPath: string,
    rootDelegationId: string,
    delegationId: string,
    prompt: string,
): Promise<{ pointer: string; promptDigest: string }> {
    for (const id of [rootDelegationId, delegationId])
        if (!/^(?:[\da-f-]{36}|dispatch-[\da-f]{64})$/u.test(id))
            throw new CaxriError(
                'VALIDATION',
                'Delegation follow-up requires generated identifiers',
            );
    const root = join(userDataPath, 'delegations');
    await privateDirectory(root);
    const directory = join(root, rootDelegationId);
    await privateDirectory(directory);
    const path = join(directory, `${delegationId}.md`);
    await writeFile(path, prompt, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    const pointer = `Read the delegated task from ${JSON.stringify(path)} and carry it out. Delegation ID: ${delegationId}.`;
    return { pointer, promptDigest: createHash('sha256').update(pointer).digest('hex') };
}

/**
 * Only the opaque pointer reaches argv (and process inspection). The task body lives in the private profile; exclusive
 * creation prevents a retry from replacing previously submitted work.
 */
export async function prepareDelegationLaunch(
    userDataPath: string,
    delegationId: string,
    provider: AgentProvider,
    providerSessionId: string | undefined,
    prompt: string,
    frozenLaunch: AgentLaunchSettings,
): Promise<{ launch: AgentLaunchSettings; promptDigest: string }> {
    validateDelegationLaunch(provider, frozenLaunch);
    if (!/^(?:[\da-f-]{36}|dispatch-[\da-f]{64})$/u.test(delegationId))
        throw new CaxriError('VALIDATION', 'Delegation launch requires generated identifiers');
    const root = join(userDataPath, 'delegations');
    await privateDirectory(root);
    const directory = join(root, delegationId);
    await privateDirectory(directory);
    const path = join(directory, 'task.md');
    await writeFile(path, prompt, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    const pointer = `Read the delegated task from ${JSON.stringify(path)} and carry it out. Delegation ID: ${delegationId}.`;
    return {
        launch: delegationAdapter(provider).freshLaunch(
            frozenLaunch,
            pointer,
            directory,
            providerSessionId,
        ),
        promptDigest: createHash('sha256').update(pointer).digest('hex'),
    };
}
