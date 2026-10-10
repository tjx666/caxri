import { CaxriError } from '@caxri/protocol';

import type { AgentChatResponse, AgentChatSessionHost } from './chat-provider';
import type { GrokToolCall } from './grok-items';
import { grokPermissionOutcome, mapGrokPermission } from './grok-items';
import type { JsonRpcConnection } from './json-rpc-connection';

const CANCELLED = { outcome: { outcome: 'cancelled' } };

interface PendingPermission {
    transportId: number | string;
    options: unknown;
    turnId?: string;
}

interface GrokRequestOwner {
    host: AgentChatSessionHost;
    sessionId: string;
    /**
     * The user declined or cancelled the tool call; its timeline row reads declined.
     */
    onDeclined: (toolCallId: string) => void;
}

/**
 * Grok Build's `session/request_permission` calls, held as pending Chat requests keyed by the tool call they gate. Each
 * JSON-RPC request stays unanswered until `respond`, Grok Build resolving it, the turn ending, or the process ending.
 */
export class GrokRequestBroker {
    private readonly pending = new Map<string, PendingPermission>();

    constructor(private readonly owner: GrokRequestOwner) {}

    ask(
        connection: JsonRpcConnection,
        transportId: number | string,
        call: GrokToolCall,
        options: unknown,
        turnId: string | undefined,
    ): void {
        const { host, sessionId } = this.owner;
        const key = call.id;
        const previous = this.pending.get(key);
        // A repeated request for the same tool call replaces the earlier one, which must still get an answer.
        if (previous && previous.transportId !== transportId)
            connection.respond(previous.transportId, CANCELLED);
        const isNew = !previous;
        this.pending.set(key, { transportId, options, ...(turnId && { turnId }) });
        const mapped = mapGrokPermission(call, options);
        const { requests } = host.read();
        host.apply([
            {
                op: 'state',
                state: {
                    requests: [...requests.filter((existing) => existing.id !== key), mapped].slice(
                        -20,
                    ),
                },
            },
        ]);
        if (isNew)
            host.lifecycle({
                phase: 'attentionRequested',
                agentSessionId: sessionId,
                agentTurnId: turnId,
                agentToolUseId: key,
            });
    }

    settle(key: string): void {
        if (!this.pending.delete(key)) return;
        const { host, sessionId } = this.owner;
        const { requests } = host.read();
        host.apply([
            { op: 'state', state: { requests: requests.filter((request) => request.id !== key) } },
        ]);
        host.lifecycle({
            phase: 'attentionResolved',
            agentSessionId: sessionId,
            agentToolUseId: key,
        });
    }

    /**
     * Settles the requests a finished turn left open; Grok Build no longer waits on them.
     */
    settleTurn(turnId: string): void {
        for (const [key, pending] of this.pending) if (pending.turnId === turnId) this.settle(key);
    }

    /**
     * Answers the turn's pending requests `cancelled`, as ACP requires after `session/cancel`.
     */
    cancelTurn(connection: JsonRpcConnection, turnId: string): void {
        for (const [key, pending] of this.pending)
            if (pending.turnId === turnId) {
                connection.respond(pending.transportId, CANCELLED);
                this.owner.onDeclined(key);
                this.settle(key);
            }
    }

    respond(connection: JsonRpcConnection, requestId: string, response: AgentChatResponse): void {
        const pending = this.pending.get(requestId);
        if (!pending) throw new CaxriError('CONFLICT', 'This request is no longer pending');
        if (response.kind !== 'decision')
            throw new CaxriError('VALIDATION', 'An approval needs a decision');
        connection.respond(
            pending.transportId,
            grokPermissionOutcome(pending.options, response.decision),
        );
        if (response.decision === 'decline' || response.decision === 'cancel')
            this.owner.onDeclined(requestId);
        this.settle(requestId);
    }

    /**
     * Forgets every pending request when the process ends and returns their keys. The caller clears `requests` in the
     * same patch that closes the turn, then calls `resolveAttention` with these keys.
     */
    drain(): string[] {
        const keys = this.pending.keys().toArray();
        this.pending.clear();
        return keys;
    }

    /**
     * The process took its requests with it; resolve their attention so the Session stops waiting on them.
     */
    resolveAttention(keys: readonly string[]): void {
        for (const key of keys)
            this.owner.host.lifecycle({
                phase: 'attentionResolved',
                agentSessionId: this.owner.sessionId,
                agentToolUseId: key,
            });
    }
}
