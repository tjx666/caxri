import { CaxriError, delegationApproveParametersSchema } from '@caxri/protocol';

import type { RemoteCommandDefinition } from './types';

function identifierArgument(token: string | undefined, label: string): string {
    if (!token || token.startsWith('-'))
        throw new CaxriError('VALIDATION', `Expected one ${label}`);
    return token;
}

function approveParameters(tokens: readonly string[]) {
    const [delegationId, requestId, ...flags] = tokens;
    const decisions = flags.filter((flag) => flag === '--accept' || flag === '--decline');
    if (decisions.length !== 1 || flags.length !== 3)
        throw new CaxriError(
            'VALIDATION',
            'Pass --revision <revision> and exactly one of --accept or --decline',
        );
    const at = flags.indexOf('--revision');
    return delegationApproveParametersSchema.parse({
        delegationId: identifierArgument(delegationId, 'delegation ID'),
        requestId: identifierArgument(requestId, 'request ID'),
        decision: decisions[0] === '--accept' ? 'accept' : 'decline',
        revision: identifierArgument(at === -1 ? undefined : flags[at + 1], 'revision'),
    });
}

/**
 * The command of the approval exchange: the Agent that delegated a task accepts or declines one command or file change
 * permission request of that task. Nothing of the request travels through this command; the Agent reads it from `wait`
 * or `status`, and echoes its `revision` so the decision lands only on the version it read.
 */
export const DELEGATION_APPROVAL_COMMANDS: RemoteCommandDefinition[] = [
    {
        kind: 'remote',
        path: ['agent', 'delegate', 'approve'],
        method: 'agent.delegation.approve',
        summary:
            'Accept or decline one command or file change permission request of one of your delegated tasks.',
        usage: '<delegation-id> <request-id> --revision <revision> (--accept | --decline)',
        parseParams: approveParameters,
    },
];
