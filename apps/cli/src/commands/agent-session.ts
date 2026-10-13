import { CaxriError } from '@caxri/protocol';

import type { RemoteCommandDefinition } from './types';

function sessionTarget(command: string) {
    return (tokens: readonly string[]) => {
        if (tokens.length !== 1 || tokens[0].startsWith('-'))
            throw new CaxriError(
                'VALIDATION',
                `agent session ${command} requires one <session-id>`,
            );
        return { sessionId: tokens[0] };
    };
}

function renameParameters(tokens: readonly string[]) {
    let sessionId: string | undefined;
    let title: string | undefined;
    for (let index = 0; index < tokens.length; index += 1) {
        const token = tokens[index];
        if (token === '--title' && title === undefined && index + 1 < tokens.length) {
            title = tokens[index + 1];
            index += 1;
        } else if (sessionId === undefined && !token.startsWith('-')) sessionId = token;
        else throw new CaxriError('VALIDATION', `Unexpected argument: ${token.split('=', 1)[0]}`);
    }
    if (!sessionId || title === undefined)
        throw new CaxriError(
            'VALIDATION',
            'agent session rename requires <session-id> --title <text>',
        );
    return { sessionId, title };
}

/**
 * Tidying up the Sessions an Agent's own Session created with `agent delegate create --new-session`. The Server refuses
 * every other Session, so these never reach the user's own work.
 */
export const AGENT_SESSION_COMMANDS: RemoteCommandDefinition[] = [
    {
        kind: 'remote',
        path: ['agent', 'session', 'rename'],
        method: 'agent.session.rename',
        summary: 'Rename a Session your Session created.',
        usage: '<session-id> --title <text>',
        parseParams: renameParameters,
        quietIdKey: 'sessionId',
        requiresAgentEndpoint: true,
    },
    {
        kind: 'remote',
        path: ['agent', 'session', 'archive'],
        method: 'agent.session.archive',
        summary:
            'Archive a Session your Session created once its work is done; the user can restore it from Archived Sessions.',
        usage: '<session-id>',
        parseParams: sessionTarget('archive'),
        quietIdKey: 'sessionId',
        requiresAgentEndpoint: true,
    },
    {
        kind: 'remote',
        path: ['agent', 'session', 'unarchive'],
        method: 'agent.session.unarchive',
        summary: 'Restore an archived Session your Session created to the top of its Project.',
        usage: '<session-id>',
        parseParams: sessionTarget('unarchive'),
        quietIdKey: 'sessionId',
        requiresAgentEndpoint: true,
    },
];
