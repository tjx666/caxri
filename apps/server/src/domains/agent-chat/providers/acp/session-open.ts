import type { AgentChatPatchOperation } from '@caxri/protocol';
import { coerce, lt } from 'semver';

import { readVersion } from '../../../agents';
import { isRecord } from '../../chat-items';
import type { ChatProcessEnd } from '../../chat-provider';
import { AgentChatStartError } from '../../chat-provider';
import type { JsonRpcConnection } from '../../json-rpc-connection';
import type { AcpDialect } from './dialect';
import { ACP_PROTOCOL_VERSION, acpInitializeParameters } from './items';
import type { AcpUpdates } from './updates';

/**
 * Opening an ACP Chat: the `initialize` handshake, then `session/new` for a conversation that is not bound yet, or
 * `session/load` replaying a bound one through the session's updates. Every failure closes the connection and rejects
 * with an {@link AgentChatStartError} carrying a closed reason.
 */

type Json = Record<string, unknown>;

const HANDSHAKE_TIMEOUT_MS = 15_000;
const SESSION_OPEN_TIMEOUT_MS = 30_000;

/**
 * Closes the connection that failed to open and rejects with `error`.
 */
async function failAcpStart(
    connection: JsonRpcConnection,
    error: AgentChatStartError,
): Promise<never> {
    await connection.close();
    throw error;
}

/**
 * Whether `version` (free text such as `agy 1.4.11`) names a release older than `minimum`; an unreadable version is not
 * older, so a CLI with an unexpected version string still gets its chance.
 */
function isOlderThan(version: unknown, minimum: string): boolean {
    const parsed = typeof version === 'string' ? coerce(version) : null;
    return parsed !== null && lt(parsed, minimum);
}

/**
 * `initialize`, returning the agent's result. `dialect` names the agent in errors and sets its oldest supported CLI.
 * `spawnFailure` reports how the process ended if it never started, which explains a failed handshake better than the
 * handshake error does. A failed handshake from a CLI older than the dialect's `minimumVersion` (one that has no ACP
 * server yet) and a handshake whose `agentInfo.version` is older both fail as `unsupported_version`.
 */
export async function initializeAcpConnection(
    connection: JsonRpcConnection,
    dialect: Pick<AcpDialect, 'label' | 'minimumVersion' | 'provider'>,
    options: { clientVersion: string; executable: string },
    spawnFailure: () => ChatProcessEnd | undefined,
): Promise<Json> {
    const { label, minimumVersion } = dialect;
    const tooOld = new AgentChatStartError(
        'unsupported_version',
        `This ${label} version does not support Chat`,
    );
    let initialized: unknown;
    try {
        initialized = await connection.request(
            'initialize',
            acpInitializeParameters(options.clientVersion),
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
        if (
            minimumVersion !== undefined &&
            isOlderThan(await readVersion(dialect.provider, options.executable), minimumVersion)
        )
            return failAcpStart(connection, tooOld);
        return failAcpStart(
            connection,
            new AgentChatStartError('handshake_failed', `${label} did not complete its handshake`),
        );
    }
    if (
        !isRecord(initialized) ||
        initialized.protocolVersion !== ACP_PROTOCOL_VERSION ||
        (minimumVersion !== undefined &&
            isOlderThan(
                isRecord(initialized.agentInfo) ? initialized.agentInfo.version : undefined,
                minimumVersion,
            ))
    )
        return failAcpStart(connection, tooOld);
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

/**
 * Replays a bound conversation through `session/load`, which streams the history as session updates into `updates`
 * before it answers, then applies it as one reset.
 */
export async function loadAcpSession(
    connection: JsonRpcConnection,
    dialect: Pick<AcpDialect, 'label' | 'settledReplayTurns'>,
    parameters: Json,
    updates: AcpUpdates,
    apply: (operations: AgentChatPatchOperation[]) => void,
): Promise<unknown> {
    updates.beginReplay();
    let result: unknown;
    try {
        result = await connection.request('session/load', parameters, SESSION_OPEN_TIMEOUT_MS);
    } catch {
        updates.endReplay(false);
        return failAcpStart(
            connection,
            new AgentChatStartError(
                'resume_failed',
                `${dialect.label} could not resume this conversation`,
            ),
        );
    }
    apply(updates.endReplay(true, dialect.settledReplayTurns));
    return result;
}
