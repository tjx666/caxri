import { CaxriError } from '@caxri/protocol';

import type { RemoteCommandDefinition } from './types';

function sessionCreateParameters(tokens: readonly string[]) {
    if (tokens.length !== 2 || tokens[0] !== '--project' || tokens[1].startsWith('--'))
        throw new CaxriError('VALIDATION', 'commander session create requires one --project <id>');
    return { projectId: tokens[1] };
}

/**
 * Agent Commander commands. The Commander's own Agent Terminal runs them non-interactively: its Endpoint carries the
 * `commander` capability, so only a human owner is asked to confirm. See `docs/agent-commander.md`.
 */
export const COMMANDER_COMMANDS: RemoteCommandDefinition[] = [
    {
        kind: 'remote',
        path: ['commander', 'board'],
        method: 'commander.board',
        summary: 'Read every visible Project and Session with Agent state and pull requests.',
        parseParams: (tokens) => {
            if (tokens.length > 0)
                throw new CaxriError(
                    'VALIDATION',
                    `Unexpected argument: ${tokens[0].split('=', 1)[0]}`,
                );
            return {};
        },
        quietKey: 'rows',
        quietIdKey: 'sessionId',
    },
    {
        kind: 'remote',
        path: ['commander', 'session', 'create'],
        method: 'commander.session.create',
        summary: 'Create an empty Session to delegate one task into.',
        usage: '--project <id>',
        ownerConfirmation: 'Create an empty Session for the Agent Commander?',
        parseParams: sessionCreateParameters,
        quietIdKey: 'sessionId',
    },
];
