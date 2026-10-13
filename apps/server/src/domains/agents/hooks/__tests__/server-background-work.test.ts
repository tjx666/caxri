import { describe, expect, it } from 'vitest';

import { createTestServer, send, validPayload } from './server.fixture';

describe('AgentHookServer background work flag', () => {
    it.each([
        { provider: 'claude', accepted: true },
        { provider: 'claude', agentBackgroundWork: false, accepted: false },
        { provider: 'claude', phase: 'turnStarted', accepted: false },
        { provider: 'claude', agentId: 'child', accepted: false },
        { provider: 'codex', accepted: false },
    ] as const)(
        'validates main-turn Claude background work (%#)',
        async ({ accepted, provider, ...fields }) => {
            const { server, socketPath } = await createTestServer();
            try {
                const token = server.register('terminal-1', 'launch-1', provider);
                const response = await send(
                    socketPath,
                    validPayload({
                        token,
                        provider,
                        phase: 'turnFinished',
                        agentBackgroundWork: true,
                        ...fields,
                    }),
                );
                expect(response).toBe(accepted ? '{"ok":true}\n' : '{"ok":false}\n');
            } finally {
                await server.close();
            }
        },
    );
});
