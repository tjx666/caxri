import { createHash } from 'node:crypto';
import { lstat, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { AgentLaunchSettings } from '@caxri/protocol';
import { CaxriError } from '@caxri/protocol';

const valueFlags = new Set([
    '--model',
    '--effort',
    '--permission-mode',
    '--agent',
    '--name',
    '--tools',
]);
const booleanFlags = new Set([
    '--verbose',
    '--disable-slash-commands',
    '--strict-mcp-config',
    '--dangerously-skip-permissions',
]);

/**
 * Delegations own native session identity and interactive submission. An ambiguous positional argument or caller-owned
 * session flag must fail before a Terminal or task file is created.
 */
export function validateDelegationLaunch(launch: AgentLaunchSettings): void {
    for (let index = 0; index < launch.args.length; index++) {
        const argument = launch.args[index];
        const flag = argument.split('=', 1)[0];
        if (booleanFlags.has(argument)) continue;
        if (valueFlags.has(flag)) {
            const value = argument.includes('=')
                ? argument.slice(flag.length + 1)
                : launch.args[++index];
            if (value && !value.startsWith('-')) continue;
        }
        throw new CaxriError(
            'CONFLICT',
            'Agent launch arguments are unsupported for visible delegation',
        );
    }
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
 * Only the opaque pointer reaches argv (and process inspection). The task body lives in the private profile; exclusive
 * creation prevents a retry from replacing previously submitted work.
 */
export async function prepareDelegationLaunch(
    userDataPath: string,
    delegationId: string,
    providerSessionId: string,
    prompt: string,
    frozenLaunch: AgentLaunchSettings,
): Promise<{ launch: AgentLaunchSettings; promptDigest: string }> {
    validateDelegationLaunch(frozenLaunch);
    if (
        !/^(?:[\da-f-]{36}|dispatch-[\da-f]{64})$/u.test(delegationId) ||
        !/^[\da-f-]{36}$/u.test(providerSessionId)
    )
        throw new CaxriError('VALIDATION', 'Delegation launch requires generated identifiers');
    const root = join(userDataPath, 'delegations');
    await privateDirectory(root);
    const directory = join(root, delegationId);
    await privateDirectory(directory);
    const path = join(directory, 'task.md');
    await writeFile(path, prompt, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    const pointer = `Read the delegated task from ${JSON.stringify(path)} and carry it out. Delegation ID: ${delegationId}.`;
    return {
        launch: {
            executable: frozenLaunch.executable,
            args: [
                ...frozenLaunch.args,
                '--session-id',
                providerSessionId,
                '--add-dir',
                directory,
                '--',
                pointer,
            ],
        },
        promptDigest: createHash('sha256').update(pointer).digest('hex'),
    };
}
