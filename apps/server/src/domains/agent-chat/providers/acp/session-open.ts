import { isRecord } from '../../chat-items';
import type { ChatProcessEnd } from '../../chat-provider';
import { AgentChatStartError } from '../../chat-provider';
import type { JsonRpcConnection } from '../../json-rpc-connection';
import { ACP_PROTOCOL_VERSION, acpInitializeParameters } from './items';

/**
 * Opening an ACP Chat: the `initialize` handshake, then `session/new` for a conversation that is not bound yet. Every
 * failure closes the connection and rejects with an {@link AgentChatStartError} carrying a closed reason. Resuming
 * through `session/load` stays in the session because it replays history through the session's updates.
 */

type Json = Record<string, unknown>;

const HANDSHAKE_TIMEOUT_MS = 15_000;
export const SESSION_OPEN_TIMEOUT_MS = 30_000;

/**
 * Closes the connection that failed to open and rejects with `error`.
 */
export async function failAcpStart(
    connection: JsonRpcConnection,
    error: AgentChatStartError,
): Promise<never> {
    await connection.close();
    throw error;
}

/**
 * `initialize`, returning the agent's result. `label` names the agent in errors. `spawnFailure` reports how the process
 * ended if it never started, which explains a failed handshake better than the handshake error does.
 */
export async function initializeAcpConnection(
    connection: JsonRpcConnection,
    label: string,
    clientVersion: string,
    spawnFailure: () => ChatProcessEnd | undefined,
): Promise<Json> {
    let initialized: unknown;
    try {
        initialized = await connection.request(
            'initialize',
            acpInitializeParameters(clientVersion),
            HANDSHAKE_TIMEOUT_MS,
        );
    } catch {
        const failure = spawnFailure();
        if (failure?.reason === 'spawnFailed')
            return failAcpStart(
                connection,
                failure.code === 'ENOENT'
                    ? new AgentChatStartError('executable_not_found', `${label} CLI was not found`)
                    : new AgentChatStartError('spawn_failed', `${label} could not be started`),
            );
        return failAcpStart(
            connection,
            new AgentChatStartError('handshake_failed', `${label} did not complete its handshake`),
        );
    }
    if (!isRecord(initialized) || initialized.protocolVersion !== ACP_PROTOCOL_VERSION)
        return failAcpStart(
            connection,
            new AgentChatStartError(
                'unsupported_version',
                `This ${label} version does not support Chat`,
            ),
        );
    return initialized;
}

/**
 * Starts a conversation. With `sessionId`, the agent must adopt that client-chosen id (Grok Build reads it from
 * `_meta.sessionId`); without one, the agent's returned `sessionId` names the conversation.
 */
export async function newAcpSession(
    connection: JsonRpcConnection,
    label: string,
    parameters: Json,
    sessionId?: string,
): Promise<Json & { sessionId: string }> {
    let result: unknown;
    try {
        result = await connection.request('session/new', parameters, SESSION_OPEN_TIMEOUT_MS);
    } catch {
        return failAcpStart(
            connection,
            new AgentChatStartError('handshake_failed', `${label} could not start a conversation`),
        );
    }
    const returned = isRecord(result) ? result.sessionId : undefined;
    if (
        typeof returned !== 'string' ||
        !isRecord(result) ||
        !/^[\w-]{1,200}$/u.test(returned) ||
        (sessionId !== undefined && returned !== sessionId)
    )
        return failAcpStart(
            connection,
            new AgentChatStartError(
                'handshake_failed',
                `${label} did not return this conversation`,
            ),
        );
    return { ...result, sessionId: returned };
}
