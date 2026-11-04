import { CaxriError } from '@caxri/protocol';

import type { RemoteCommandDefinition } from '../types';

/**
 * Reads `<task-id>`: any task of the Session the user took over.
 */
function handBackParameters(tokens: readonly string[]) {
    const [delegationId, ...rest] = tokens;
    if (!delegationId || delegationId.startsWith('-') || rest.length > 0)
        throw new CaxriError('VALIDATION', 'Expected one delegation ID');
    return { delegationId };
}

export const DELEGATION_HAND_BACK_COMMANDS: RemoteCommandDefinition[] = [
    {
        kind: 'remote',
        path: ['agent', 'delegate', 'hand-back'],
        method: 'agent.delegation.handBack',
        quietIdKey: 'grantId',
        requiresHumanOwner: true,
        summary:
            'Give a Session you took over back to the Agent that delegated it, so it may continue with one follow-up.',
        usage: '<delegation-id>',
        confirmation: 'Hand this Session back to the Agent that delegated it?',
        parseParams: handBackParameters,
    },
];
