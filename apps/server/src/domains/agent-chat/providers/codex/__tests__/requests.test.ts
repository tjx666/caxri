import type { AgentChatRequest } from '@caxri/protocol';
import { describe, expect, it, vi } from 'vitest';

import type { AgentChatSessionHost } from '../../../chat-provider';
import type { JsonRpcConnection } from '../../../json-rpc-connection';
import { CodexRequestBroker } from '../requests';

function fixture() {
    let requests: AgentChatRequest[] = [];
    const host = {
        read: () => ({ requests }),
        apply: vi.fn(
            (operations: Array<{ op: string; state?: { requests: AgentChatRequest[] } }>) => {
                for (const operation of operations)
                    if (operation.op === 'state' && operation.state)
                        requests = operation.state.requests;
            },
        ),
        lifecycle: vi.fn(),
        onProtocolRejected: vi.fn(),
    } as unknown as AgentChatSessionHost;
    const respond = vi.fn();
    const connection = { respond, respondError: vi.fn() } as unknown as JsonRpcConnection;
    const broker = new CodexRequestBroker(host, () => 'thread');
    return { broker, connection, respond };
}

const command = (extra: Record<string, unknown>) => ({
    id: 7,
    method: 'item/commandExecution/requestApproval',
    params: { itemId: 'cmd', turnId: 't', command: 'git push', ...extra },
});

describe('CodexRequestBroker acceptAlways', () => {
    it('answers with Codex own amendment, which the Client never carried', () => {
        const { broker, connection, respond } = fixture();
        broker.receive(
            connection,
            command({
                availableDecisions: [
                    'accept',
                    { acceptWithExecpolicyAmendment: { execpolicy_amendment: ['git', 'push'] } },
                    'cancel',
                ],
            }),
        );
        broker.respond(connection, 'cmd', { kind: 'decision', decision: 'acceptAlways' });
        expect(respond).toHaveBeenCalledWith(7, {
            decision: { acceptWithExecpolicyAmendment: { execpolicy_amendment: ['git', 'push'] } },
        });
    });

    it('rejects acceptAlways when Codex proposed no amendment, instead of running it once', () => {
        const { broker, connection, respond } = fixture();
        broker.receive(connection, command({ availableDecisions: ['accept', 'cancel'] }));
        expect(() =>
            broker.respond(connection, 'cmd', { kind: 'decision', decision: 'acceptAlways' }),
        ).toThrow(/no command prefix/u);
        expect(respond).not.toHaveBeenCalled();
        // The request stays pending so the user can still answer it.
        broker.respond(connection, 'cmd', { kind: 'decision', decision: 'accept' });
        expect(respond).toHaveBeenCalledWith(7, { decision: 'accept' });
    });
});
