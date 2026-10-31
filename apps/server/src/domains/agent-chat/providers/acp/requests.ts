import type { AgentChatRequest, AgentChatResponse } from '@caxri/protocol';
import { agentChatAnsweredNotice, CaxriError } from '@caxri/protocol';

import { questionAnswers } from '../../chat-items';
import type { AgentChatSessionHost } from '../../chat-provider';
import type { JsonRpcConnection } from '../../json-rpc-connection';
import type { AcpToolCall, AcpToolPresentation } from './items';
import { acpPermissionOutcome, mapAcpPermission } from './items';

type Json = Record<string, unknown>;

const CANCELLED = { outcome: { outcome: 'cancelled' } };
/**
 * Grok Build's `_x.ai/ask_user_question` answers its outcome at the top level, unlike `session/request_permission`.
 */
const QUESTION_CANCELLED = { outcome: 'cancelled' };

type PendingRequest =
    | { kind: 'permission'; transportId: number | string; options: unknown; turnId?: string }
    | { kind: 'question'; transportId: number | string; questions: unknown; turnId?: string };

function cancelledResponse(pending: PendingRequest) {
    return pending.kind === 'question' ? QUESTION_CANCELLED : CANCELLED;
}

/**
 * A provider's question extension: how its request reads as a question card and how the Client's answers go back.
 */
export interface AcpQuestionDialect {
    request: (key: string, questions: unknown) => Extract<AgentChatRequest, { kind: 'question' }>;
    answers: (questions: unknown, answers: Readonly<Record<string, readonly string[]>>) => Json;
}

interface AcpRequestOwner {
    host: AgentChatSessionHost;
    /**
     * The conversation's current id, read when a request is held or settled.
     */
    sessionId: () => string;
    presentation: AcpToolPresentation;
    questions?: AcpQuestionDialect;
    /**
     * The user declined or cancelled the tool call; its timeline row reads declined.
     */
    onDeclined: (toolCallId: string) => void;
}

/**
 * An ACP agent's `session/request_permission` calls, and its question extension's calls, held as pending Chat requests
 * keyed by the tool call they belong to. Each JSON-RPC request stays unanswered until `respond`, the agent resolving
 * it, the turn ending, or the process ending.
 */
export class AcpRequestBroker {
    private readonly pending = new Map<string, PendingRequest>();

    constructor(private readonly owner: AcpRequestOwner) {}

    private hold(
        connection: JsonRpcConnection,
        pending: PendingRequest,
        mapped: AgentChatRequest,
    ): void {
        const { host } = this.owner;
        const sessionId = this.owner.sessionId();
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
        call: AcpToolCall,
        options: unknown,
        turnId: string | undefined,
    ): void {
        this.hold(
            connection,
            { kind: 'permission', transportId, options, ...(turnId && { turnId }) },
            mapAcpPermission(call, options, this.owner.presentation),
        );
    }

    /**
     * Holds a question extension's request as a question card keyed by its tool call.
     */
    askQuestion(
        connection: JsonRpcConnection,
        transportId: number | string,
        key: string,
        questions: unknown,
        turnId: string | undefined,
    ): void {
        const dialect = this.owner.questions;
        if (!dialect) throw new CaxriError('CONFLICT', 'This agent asks no questions');
        this.hold(
            connection,
            { kind: 'question', transportId, questions, ...(turnId && { turnId }) },
            dialect.request(key, questions),
        );
    }

    settle(key: string): void {
        if (!this.pending.delete(key)) return;
        const { host } = this.owner;
        const sessionId = this.owner.sessionId();
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
     * Settles the requests a finished turn left open; the agent no longer waits on them. A question Grok Build left
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
                this.owner.questions?.answers(pending.questions, answers) ?? QUESTION_CANCELLED,
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
            acpPermissionOutcome(pending.options, response.decision),
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
                agentSessionId: this.owner.sessionId(),
                agentToolUseId: key,
            });
    }
}
