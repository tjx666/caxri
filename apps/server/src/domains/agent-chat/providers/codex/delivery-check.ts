import { CaxriError } from '@caxri/protocol';

import { isRecord } from '../../chat-items';
import type { AgentChatSessionHost } from '../../chat-provider';
import { deliveryUnknownError, turnNotSteerableError } from '../../chat-provider';
import type { JsonRpcConnection } from '../../json-rpc-connection';
import { JsonRpcRequestError } from '../../json-rpc-connection';
import {
    codexClientMessageId,
    codexUserInput,
    isSteerTargetGone,
    isSteerTargetNotSteerable,
} from './input';

export const TURN_REQUEST_TIMEOUT_MS = 30_000;

/**
 * Bound on the read that checks whether a timed-out input still reached Codex.
 */
const READ_REQUEST_TIMEOUT_MS = 10_000;

/**
 * Newest turns read when checking a timed-out input; it can only be in one of the last few.
 */
const DELIVERY_CHECK_TURNS = 5;

/**
 * Tells whether a turn input whose request timed out still reached Codex (#1609), from the user message echoes Codex
 * sent back or, failing that, its newest turns.
 */
export class CodexDeliveryCheck {
    /**
     * `clientId`s of user messages Codex echoed back, so a timed-out send can tell it arrived anyway.
     */
    private readonly echoedClientIds = new Set<string>();

    constructor(
        private readonly host: Pick<
            AgentChatSessionHost,
            'onDeliveryChecked' | 'turnRequestTimeoutMs'
        >,
        private readonly threadId: () => string | undefined,
    ) {}

    /**
     * Whether Codex recorded the user message sent as `clientUserMessageId`: its echo already arrived, or one of the
     * newest turns holds it. A failed read counts as not confirmed.
     */
    private async wasDelivered(
        connection: JsonRpcConnection,
        clientUserMessageId: string,
    ): Promise<boolean> {
        if (this.echoedClientIds.has(clientUserMessageId)) return true;
        let result: unknown;
        try {
            result = await connection.request(
                'thread/turns/list',
                {
                    threadId: this.threadId(),
                    limit: DELIVERY_CHECK_TURNS,
                    sortDirection: 'desc',
                    itemsView: 'full',
                },
                READ_REQUEST_TIMEOUT_MS,
            );
        } catch {
            return this.echoedClientIds.has(clientUserMessageId);
        }
        const turns = isRecord(result) && Array.isArray(result.data) ? result.data : [];
        return (
            this.echoedClientIds.has(clientUserMessageId) ||
            turns.some(
                (turn) =>
                    isRecord(turn) &&
                    Array.isArray(turn.items) &&
                    turn.items.some(
                        (item) =>
                            isRecord(item) &&
                            item.type === 'userMessage' &&
                            item.clientId === clientUserMessageId,
                    ),
            )
        );
    }

    rememberEcho(clientId: unknown): void {
        if (typeof clientId !== 'string') return;
        this.echoedClientIds.add(clientId);
        for (const key of this.echoedClientIds) {
            if (this.echoedClientIds.size <= DELIVERY_CHECK_TURNS * 4) break;
            this.echoedClientIds.delete(key);
        }
    }

    /**
     * Sends a request that starts or steers a turn. A timeout does not say whether Codex received it, so it is checked
     * before failing: a message Codex recorded resolves as delivered (`undefined`), and one it cannot confirm fails as
     * delivery unknown so nothing sends it twice (#1609). A provider error still means it was not delivered.
     */
    async request(
        connection: JsonRpcConnection,
        method: 'turn/start' | 'turn/steer',
        clientUserMessageId: string,
        request: (timeoutMs: number) => Promise<unknown>,
    ): Promise<unknown> {
        const timeoutMs = this.host.turnRequestTimeoutMs ?? TURN_REQUEST_TIMEOUT_MS;
        try {
            return await request(timeoutMs);
        } catch (error) {
            if (!(error instanceof CaxriError && error.code === 'TIMEOUT')) throw error;
            if (await this.wasDelivered(connection, clientUserMessageId)) {
                this.host.onDeliveryChecked(method, 'delivered');
                return undefined;
            }
            this.host.onDeliveryChecked(method, 'unknown');
            throw deliveryUnknownError('Codex');
        }
    }

    /**
     * Steers a note from Caxri into turn `turnId` under a `notice:` client id, which the timeline shows as a notice
     * (`isCodexNotice`). Resolves `false` when the turn ended before the note arrived: unlike a message, a note about a
     * turn that already ended must not start the next one.
     */
    async didSteerNotice(
        connection: JsonRpcConnection,
        turnId: string,
        text: string,
    ): Promise<boolean> {
        const clientUserMessageId = codexClientMessageId('notice');
        try {
            await this.request(connection, 'turn/steer', clientUserMessageId, (timeoutMs) =>
                connection.request(
                    'turn/steer',
                    {
                        threadId: this.threadId(),
                        input: codexUserInput({ text }),
                        expectedTurnId: turnId,
                        clientUserMessageId,
                    },
                    timeoutMs,
                ),
            );
            return true;
        } catch (error) {
            if (error instanceof JsonRpcRequestError && isSteerTargetGone(error)) return false;
            throw error;
        }
    }
}

/**
 * One message steered into the turn Codex is running.
 */
export interface CodexSteer {
    connection: JsonRpcConnection;
    deliveries: CodexDeliveryCheck;
    threadId: string | undefined;
    input: ReturnType<typeof codexUserInput>;
    expectedTurnId: string;
    clientUserMessageId: string;
}

/**
 * Adds a message to the running turn, and resolves `false` when that turn ended first.
 *
 * The turn can finish between reading its id and the steer arriving; Codex then rejects the precondition, and the
 * caller starts the next turn with the message instead of losing it. It was not steered after all, so it goes out under
 * a new id that carries no marker. A review or compaction turn refuses steered input outright; that rejects with
 * {@link turnNotSteerableError} so the service queues the message behind the turn.
 */
export async function didSteerCodexTurn(steer: CodexSteer): Promise<boolean> {
    const { connection, deliveries, threadId, input, expectedTurnId, clientUserMessageId } = steer;
    try {
        await deliveries.request(connection, 'turn/steer', clientUserMessageId, (timeoutMs) =>
            connection.request(
                'turn/steer',
                { threadId, input, expectedTurnId, clientUserMessageId },
                timeoutMs,
            ),
        );
        return true;
    } catch (error) {
        if (!(error instanceof JsonRpcRequestError)) throw error;
        if (isSteerTargetNotSteerable(error)) throw turnNotSteerableError(error.message);
        if (!isSteerTargetGone(error))
            throw new CaxriError('CONFLICT', 'Codex cannot add this message to the running turn');
        return false;
    }
}
