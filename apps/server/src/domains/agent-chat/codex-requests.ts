import type { AgentChatRequest, AgentChatResponse } from '@caxri/protocol';
import { agentChatAnsweredNotice, CaxriError } from '@caxri/protocol';

import { codexExecpolicyAmendment } from './approval/codex-decisions';
import { clip, questionAnswers, stringField } from './chat-items';
import type { AgentChatSessionHost } from './chat-provider';
import type { CodexRequestKind } from './codex-items';
import { codexRequestKey, codexRequestKind, mapCodexRequest } from './codex-items';
import type { JsonRpcConnection, JsonRpcServerRequest } from './json-rpc-connection';

interface PendingRequest {
    transportId: number | string;
    kind: CodexRequestKind;
    turnId?: string;
    /**
     * The command prefix rule Codex proposed, held here so the Client only names `acceptAlways` and never carries it.
     */
    execpolicyAmendment?: string[];
}

/**
 * Codex app-server's approval and question requests, held as pending Chat requests keyed by the item they belong to.
 * Each JSON-RPC request stays unanswered until `respond`, Codex resolving it, its turn ending, or the process ending.
 */
export class CodexRequestBroker {
    private readonly pending = new Map<string, PendingRequest>();

    private rejectedCount = 0;

    constructor(
        private readonly host: AgentChatSessionHost,
        private readonly threadId: () => string | undefined,
    ) {}

    /**
     * Server requests Caxri refused because it does not support or cannot key them.
     */
    get rejected(): number {
        return this.rejectedCount;
    }

    receive(connection: JsonRpcConnection, request: JsonRpcServerRequest): void {
        const kind = codexRequestKind(request.method);
        if (!kind) {
            this.rejectedCount += 1;
            this.host.onProtocolRejected('unsupportedRequest', request.method);
            /**
             * Every server request must be answered or the turn blocks. MCP elicitation has a protocol-level decline;
             * everything else gets a JSON-RPC error.
             */
            if (request.method === 'mcpServer/elicitation/request')
                connection.respond(request.id, { action: 'decline', content: null, _meta: null });
            else
                connection.respondError(
                    request.id,
                    -32601,
                    'Caxri Chat does not support this request',
                );
            return;
        }
        const key = codexRequestKey(request.params);
        if (!key) {
            this.rejectedCount += 1;
            this.host.onProtocolRejected('unkeyedRequest', request.method);
            connection.respondError(request.id, -32602, 'Request is missing its item id');
            return;
        }
        const turnId = stringField(request.params.turnId);
        const isNew = !this.pending.has(key);
        const amendment = kind === 'command' ? codexExecpolicyAmendment(request.params) : undefined;
        this.pending.set(key, {
            transportId: request.id,
            kind,
            ...(turnId && { turnId: clip(turnId, 200) }),
            ...(amendment && { execpolicyAmendment: amendment }),
        });
        const mapped: AgentChatRequest = mapCodexRequest(kind, key, request.params);
        const { requests } = this.host.read();
        this.host.apply([
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
            this.host.lifecycle({
                phase: 'attentionRequested',
                agentSessionId: this.threadId(),
                agentTurnId: turnId,
                agentToolUseId: key,
            });
    }

    settle(key: string): void {
        if (!this.pending.delete(key)) return;
        const { requests } = this.host.read();
        this.host.apply([
            { op: 'state', state: { requests: requests.filter((request) => request.id !== key) } },
        ]);
        this.host.lifecycle({
            phase: 'attentionResolved',
            agentSessionId: this.threadId(),
            agentToolUseId: key,
        });
    }

    /**
     * Codex resolved the request itself (`serverRequest/resolved`), for example because its turn was interrupted.
     */
    onResolved(transportId: unknown): void {
        for (const [key, pending] of this.pending)
            if (pending.transportId === transportId) this.settle(key);
    }

    /**
     * Whether request `requestId` belongs to a turn other than `finishedTurnId` and outlives it. A request of the
     * finished turn, or one with no known turn, is dropped and reported as not outliving it.
     */
    outlivesTurn(requestId: string, finishedTurnId: string): boolean {
        const pending = this.pending.get(requestId);
        if (pending?.turnId !== undefined && pending.turnId !== finishedTurnId) return true;
        this.pending.delete(requestId);
        return false;
    }

    /**
     * Forgets every pending request after the process ended and returns their keys.
     */
    drain(): string[] {
        const keys = this.pending.keys().toArray();
        this.pending.clear();
        return keys;
    }

    respond(connection: JsonRpcConnection, requestId: string, response: AgentChatResponse): void {
        const pending = this.pending.get(requestId);
        if (!pending) throw new CaxriError('CONFLICT', 'This request is no longer pending');
        if (pending.kind === 'question') {
            const answers = questionAnswers(response);
            connection.respond(pending.transportId, {
                answers: Object.fromEntries(
                    Object.entries(answers).map(([id, values]) => [id, { answers: values }]),
                ),
            });
            const answered = agentChatAnsweredNotice(
                this.host.read().requests.find((request) => request.id === requestId),
                pending.turnId,
                answers,
            );
            if (answered) this.host.apply([{ op: 'upsertItem', item: answered }]);
        } else {
            if (response.kind !== 'decision')
                throw new CaxriError('VALIDATION', 'An approval needs a decision');
            if (response.decision === 'acceptAlways') {
                if (!pending.execpolicyAmendment)
                    throw new CaxriError(
                        'VALIDATION',
                        'Codex proposed no command prefix to remember',
                    );
                connection.respond(pending.transportId, {
                    decision: {
                        acceptWithExecpolicyAmendment: {
                            execpolicy_amendment: pending.execpolicyAmendment,
                        },
                    },
                });
            } else connection.respond(pending.transportId, { decision: response.decision });
        }
        this.settle(requestId);
    }
}
