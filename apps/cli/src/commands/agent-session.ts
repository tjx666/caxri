import { CaxriError, MAX_AGENT_SESSION_SEND_TEXT_LENGTH } from '@caxri/protocol';

import { readBoundedTextFile } from './text-file';
import type { RemoteCommandDefinition } from './types';

/**
 * A character is at most four UTF-8 bytes, so the file read is bounded by bytes and the schema then bounds characters.
 */
const MAX_UTF8_BYTES_PER_CHAR = 4;

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
 * Reads `<session-id> (--text <text> | --prompt-file <path>)` for a relay into another Session.
 */
async function sendParameters(tokens: readonly string[]) {
    let sessionId: string | undefined;
    const values = new Map<string, string>();
    for (let index = 0; index < tokens.length; index += 1) {
        const token = tokens[index];
        if (
            (token === '--text' || token === '--prompt-file') &&
            !values.has(token) &&
            index + 1 < tokens.length
        ) {
            values.set(token, tokens[index + 1]);
            index += 1;
        } else if (sessionId === undefined && !token.startsWith('-')) sessionId = token;
        else throw new CaxriError('VALIDATION', `Unexpected argument: ${token.split('=', 1)[0]}`);
    }
    const file = values.get('--prompt-file');
    const text = values.get('--text');
    if (!sessionId || (file === undefined) === (text === undefined))
        throw new CaxriError(
            'VALIDATION',
            'agent session send requires <session-id> and exactly one of --text <text> or --prompt-file <path>',
        );
    return {
        sessionId,
        text:
            file === undefined
                ? text
                : await readBoundedTextFile(
                      file,
                      MAX_AGENT_SESSION_SEND_TEXT_LENGTH * MAX_UTF8_BYTES_PER_CHAR,
                      'Relayed message',
                  ),
    };
}

/**
 * Tidying up the Sessions an Agent's own Session created with `agent delegate create --new-session` (the Server refuses
 * every other Session, so these never reach the user's own work), plus `send`, which relays a message the user asked
 * for into any of the user's Sessions.
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
    {
        kind: 'remote',
        path: ['agent', 'session', 'send'],
        method: 'agent.session.send',
        summary:
            "Relay a message the user asked you to pass on into another of the user's Sessions, as if they typed it there and pressed Enter.",
        usage: '<session-id> (--text <text> | --prompt-file <path>)',
        parseParams: sendParameters,
        quietIdKey: 'sessionId',
        requiresAgentEndpoint: true,
    },
];
