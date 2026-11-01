import type { AgentChatItem, AgentChatRequest } from '@caxri/protocol';
import { describe, expect, it, vi } from 'vitest';

import type { AgentChatSessionHost } from '../../../chat-provider';
import type { JsonRpcConnection } from '../../../json-rpc-connection';
import { CodexRequestBroker } from '../requests';

function fixture(items: AgentChatItem[] = []) {
    let requests: AgentChatRequest[] = [];
    const host = {
        read: () => ({ items, requests }),
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
    return { broker, connection, readRequests: () => requests, respond };
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

describe('CodexRequestBroker file changes', () => {
    it('names the files of the item a file-change approval gates', () => {
        const { broker, connection, readRequests } = fixture([
            {
                id: 'edit-1',
                type: 'fileChange',
                status: 'running',
                changes: [
                    { path: '/repo/a.ts', kind: 'update', diff: '' },
                    { path: '/repo/b.ts', kind: 'add', diff: '' },
                ],
            },
        ]);
        const fileChange = (itemId: string) => ({
            id: itemId,
            method: 'item/fileChange/requestApproval',
            params: { itemId, turnId: 't' },
        });
        broker.receive(connection, fileChange('edit-1'));
        broker.receive(connection, fileChange('edit-2'));
        expect(readRequests()).toEqual([
            {
                id: 'edit-1',
                itemId: 'edit-1',
                kind: 'fileChange',
                paths: ['/repo/a.ts', '/repo/b.ts'],
            },
            { id: 'edit-2', itemId: 'edit-2', kind: 'fileChange' },
        ]);
    });
});
