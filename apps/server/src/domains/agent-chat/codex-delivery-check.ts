import { CaxriError } from '@caxri/protocol';

import { isRecord } from './chat-items';
import type { AgentChatSessionHost } from './chat-provider';
import { deliveryUnknownError } from './chat-provider';
import type { JsonRpcConnection } from './json-rpc-connection';

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
}
