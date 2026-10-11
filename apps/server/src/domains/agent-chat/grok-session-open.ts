import { isRecord } from './chat-items';
import type { ChatProcessEnd } from './chat-provider';
import { AgentChatStartError } from './chat-provider';
import { ACP_PROTOCOL_VERSION, grokInitializeParameters } from './grok-items';
import type { JsonRpcConnection } from './json-rpc-connection';

/**
 * Opening a Grok Build Chat: the ACP `initialize` handshake, then `session/new` for a conversation that is not bound
 * yet. Every failure closes the connection and rejects with an {@link AgentChatStartError} carrying a closed reason.
 * Resuming through `session/load` stays in the session because it replays history through the session's updates.
 */

type Json = Record<string, unknown>;

const HANDSHAKE_TIMEOUT_MS = 15_000;
export const SESSION_OPEN_TIMEOUT_MS = 30_000;

/**
 * Parameters shared by `session/new` and `session/load`. `askUserQuestion: true` lets Grok Build ask through its
 * `_x.ai/ask_user_question` extension, which the Chat shows as a question card.
 */
export function grokSessionParameters(cwd: string): {
    cwd: string;
    mcpServers: [];
    _meta: Json;
} {
    return { cwd, mcpServers: [], _meta: { askUserQuestion: true } };
}

/**
 * Closes the connection that failed to open and rejects with `error`.
 */
export async function failGrokStart(
    connection: JsonRpcConnection,
    error: AgentChatStartError,
): Promise<never> {
    await connection.close();
    throw error;
}

/**
 * `initialize`, answering the agent's `_meta`. `spawnFailure` reports how the process ended if it never started, which
 * explains a failed handshake better than the handshake error does.
 */
export async function initializeGrokConnection(
    connection: JsonRpcConnection,
    clientVersion: string,
    spawnFailure: () => ChatProcessEnd | undefined,
): Promise<Json> {
    let initialized: unknown;
    try {
        initialized = await connection.request(
            'initialize',
            grokInitializeParameters(clientVersion),
            HANDSHAKE_TIMEOUT_MS,
        );
    } catch {
        const failure = spawnFailure();
        if (failure?.reason === 'spawnFailed')
            return failGrokStart(
                connection,
                failure.code === 'ENOENT'
                    ? new AgentChatStartError(
                          'executable_not_found',
                          'Grok Build CLI was not found',
                      )
                    : new AgentChatStartError('spawn_failed', 'Grok Build could not be started'),
            );
        return failGrokStart(
            connection,
            new AgentChatStartError(
                'handshake_failed',
                'Grok Build did not complete its handshake',
            ),
        );
    }
    if (!isRecord(initialized) || initialized.protocolVersion !== ACP_PROTOCOL_VERSION)
        return failGrokStart(
            connection,
            new AgentChatStartError(
                'unsupported_version',
                'This Grok Build version does not support Chat',
            ),
        );
    return isRecord(initialized._meta) ? initialized._meta : {};
}

/**
 * Starts a conversation under the client-chosen `sessionId`, which Grok Build accepts through `_meta.sessionId`.
 */
export async function newGrokSession(
    connection: JsonRpcConnection,
    sessionId: string,
    cwd: string,
): Promise<Json> {
    const parameters = grokSessionParameters(cwd);
    let result: unknown;
    try {
        result = await connection.request(
            'session/new',
            { ...parameters, _meta: { ...parameters._meta, sessionId } },
            SESSION_OPEN_TIMEOUT_MS,
        );
    } catch {
        return failGrokStart(
            connection,
            new AgentChatStartError(
                'handshake_failed',
                'Grok Build could not start a conversation',
            ),
        );
    }
    if (!isRecord(result) || result.sessionId !== sessionId)
        return failGrokStart(
            connection,
            new AgentChatStartError(
                'handshake_failed',
                'Grok Build did not return this conversation',
            ),
        );
    return result;
}
