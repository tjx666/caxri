import { Buffer } from 'node:buffer';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';

import { CaxriError } from '@caxri/protocol';

import type { RemoteCommandDefinition } from './types';

async function createParameters(tokens: readonly string[]) {
    const values = new Map<string, string>();
    for (let index = 0; index < tokens.length; index += 2) {
        const flag = tokens[index];
        const value = tokens[index + 1];
        if (
            !value ||
            ![
                '--project',
                '--session',
                '--provider',
                '--prompt-file',
                '--follow-up',
                '--resume',
            ].includes(flag) ||
            value.startsWith('--') ||
            values.has(flag)
        )
            throw new CaxriError(
                'VALIDATION',
                'Delegation requires unique project, session, provider and prompt-file options',
            );
        values.set(flag, value);
    }
    const projectId = values.get('--project');
    const sessionId = values.get('--session');
    const path = values.get('--prompt-file');
    const provider = values.get('--provider');
    if (!projectId || !sessionId || !path || (provider !== 'claude' && provider !== 'codex'))
        throw new CaxriError(
            'VALIDATION',
            'Delegation requires --project, --session, --provider claude|codex and --prompt-file',
        );
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
        const info = await file.stat();
        if (!info.isFile() || info.size > 16_384)
            throw new CaxriError(
                'VALIDATION',
                'Delegation task must be a regular file of at most 16 KiB',
            );
        const buffer = Buffer.alloc(16_385);
        const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
        if (bytesRead > 16_384)
            throw new CaxriError('VALIDATION', 'Delegation task exceeds 16 KiB');
        return {
            projectId,
            sessionId,
            provider,
            prompt: buffer.subarray(0, bytesRead).toString('utf8'),
            ...(values.has('--follow-up') && { followUpOf: values.get('--follow-up') }),
            ...(values.has('--resume') && { resumeFrom: values.get('--resume') }),
        };
    } finally {
        await file.close();
    }
}

function identity(tokens: readonly string[]) {
    if (tokens.length !== 1 || tokens[0].startsWith('-'))
        throw new CaxriError('VALIDATION', 'Expected one delegation ID');
    return { delegationId: tokens[0] };
}

export const DELEGATION_COMMANDS: RemoteCommandDefinition[] = [
    {
        kind: 'remote',
        path: ['agent', 'delegate', 'stop'],
        method: 'agent.delegation.stop',
        summary: 'Interrupt your active delegated task without closing its visible Terminal.',
        usage: '<delegation-id>',
        ownerConfirmation: 'Interrupt this delegated task?',
        parseParams: identity,
    },
    {
        kind: 'remote',
        path: ['agent', 'delegate', 'wait'],
        method: 'agent.delegation.wait',
        summary: 'Wait for the exact task result without resending or stopping it.',
        usage: '<delegation-id> [--timeout <milliseconds>]',
        parseParams: identity,
    },
    {
        kind: 'remote',
        path: ['agent', 'delegate', 'create'],
        method: 'agent.delegation.create',
        summary: 'Run a task in a visible Agent Terminal and preserve its exact result.',
        usage: '--project <id> --session <id> --provider <claude|codex> --prompt-file <path> [--follow-up <id> | --resume <id>]',
        ownerConfirmation: 'Create this visible Agent delegation?',
        parseParams: createParameters,
    },
    {
        kind: 'remote',
        path: ['agent', 'delegate', 'status'],
        method: 'agent.delegation.status',
        summary: 'Read the state of one visible Agent delegation.',
        usage: '<delegation-id>',
        parseParams: identity,
    },
    {
        kind: 'remote',
        path: ['agent', 'delegate', 'result'],
        method: 'agent.delegation.result',
        summary: 'Retrieve the private answer for one exact delegated task.',
        usage: '<delegation-id>',
        parseParams: identity,
    },
];
