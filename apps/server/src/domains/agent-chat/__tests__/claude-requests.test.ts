import { describe, expect, it, vi } from 'vitest';

import type { AgentChatSessionHost } from '../chat-provider';
import { ClaudeRequestBroker } from '../claude-requests';

function createBroker() {
    const state = { requests: [] as Array<{ id: string }>, activeTurnId: 'turn' };
    const host = {
        read: () => state,
        apply: (ops: Array<{ op: string; state?: { requests: Array<{ id: string }> } }>) => {
            for (const op of ops)
                if (op.op === 'state' && op.state) state.requests = op.state.requests;
        },
        lifecycle: vi.fn(),
    } as unknown as AgentChatSessionHost;
    return new ClaudeRequestBroker({
        host,
        sessionId: () => 's1',
        isEnded: () => false,
        onInterruptRequested: vi.fn(),
        planExitMode: () => {},
    });
}

describe('ClaudeRequestBroker approvals', () => {
    it('rejects acceptAlways, which only Codex offers, and keeps the request pending', async () => {
        const broker = createBroker();
        const result = broker.canUseTool('Bash', { command: 'ls' }, {
            toolUseID: 'tool-1',
            signal: new AbortController().signal,
        } as never);
        expect(() =>
            broker.respond('tool-1', { kind: 'decision', decision: 'acceptAlways' }),
        ).toThrow('Claude does not offer always-allow');
        await expect(Promise.race([result, Promise.resolve('pending')])).resolves.toBe('pending');
        broker.respond('tool-1', { kind: 'decision', decision: 'accept' });
        await expect(result).resolves.toMatchObject({ behavior: 'allow' });
    });
});
