import type { AgentChatRequest, AgentChatResponse } from '@caxri/protocol';
import { agentChatAnsweredNotice, CaxriError } from '@caxri/protocol';

import { questionAnswers } from '../../chat-items';
import type { AgentChatSessionHost } from '../../chat-provider';
import type { JsonRpcConnection } from '../../json-rpc-connection';
import type { GrokToolCall } from './items';
import {
    grokPermissionOutcome,
    grokQuestionAnswers,
    mapGrokPermission,
    mapGrokQuestion,
} from './items';

const CANCELLED = { outcome: { outcome: 'cancelled' } };
/**
 * `_x.ai/ask_user_question` answers its outcome at the top level, unlike `session/request_permission`.
 */
const QUESTION_CANCELLED = { outcome: 'cancelled' };

type PendingRequest =
    | { kind: 'permission'; transportId: number | string; options: unknown; turnId?: string }
    | { kind: 'question'; transportId: number | string; questions: unknown; turnId?: string };

function cancelledResponse(pending: PendingRequest) {
    return pending.kind === 'question' ? QUESTION_CANCELLED : CANCELLED;
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
 * Grok Build's `session/request_permission` and `_x.ai/ask_user_question` calls, held as pending Chat requests keyed by
 * the tool call they belong to. Each JSON-RPC request stays unanswered until `respond`, Grok Build resolving it, the
 * turn ending, or the process ending.
 */
export class GrokRequestBroker {
    private readonly pending = new Map<string, PendingRequest>();

    constructor(private readonly owner: GrokRequestOwner) {}

    private hold(
        connection: JsonRpcConnection,
        pending: PendingRequest,
        mapped: AgentChatRequest,
    ): void {
        const { host, sessionId } = this.owner;
        const key = mapped.id;
        const { turnId } = pending;
        const previous = this.pending.get(key);
        // A repeated request for the same tool call replaces the earlier one, which must still get an answer.
        if (previous && previous.transportId !== pending.transportId)
            connection.respond(previous.transportId, cancelledResponse(previous));
        const isNew = !previous;
        this.pending.set(key, pending);
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

    ask(
        connection: JsonRpcConnection,
        transportId: number | string,
        call: GrokToolCall,
        options: unknown,
        turnId: string | undefined,
    ): void {
        this.hold(
            connection,
            { kind: 'permission', transportId, options, ...(turnId && { turnId }) },
            mapGrokPermission(call, options),
        );
    }

    /**
     * Holds an `_x.ai/ask_user_question` request as a question card keyed by its `toolCallId`.
     */
    askQuestion(
        connection: JsonRpcConnection,
        transportId: number | string,
        key: string,
        questions: unknown,
        turnId: string | undefined,
    ): void {
        this.hold(
            connection,
            { kind: 'question', transportId, questions, ...(turnId && { turnId }) },
            mapGrokQuestion(key, questions),
        );
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
     * Settles the requests a finished turn left open; Grok Build no longer waits on them. A question Grok Build left
     * pending after `session/cancel` would otherwise keep its card up for an answer Grok Build ignores (verified with
     * Grok Build 1.0.50).
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
                connection.respond(pending.transportId, cancelledResponse(pending));
                if (pending.kind === 'permission') this.owner.onDeclined(key);
                this.settle(key);
            }
    }

    respond(connection: JsonRpcConnection, requestId: string, response: AgentChatResponse): void {
        const pending = this.pending.get(requestId);
        if (!pending) throw new CaxriError('CONFLICT', 'This request is no longer pending');
        if (pending.kind === 'question') {
            const answers = questionAnswers(response);
            connection.respond(
                pending.transportId,
                grokQuestionAnswers(pending.questions, answers),
            );
            const { host } = this.owner;
            const answered = agentChatAnsweredNotice(
                host.read().requests.find((request) => request.id === requestId),
                pending.turnId,
                answers,
            );
            if (answered) host.apply([{ op: 'upsertItem', item: answered }]);
            this.settle(requestId);
            return;
        }
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
