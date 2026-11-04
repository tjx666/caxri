import { describe, expect, it } from 'vitest';

import { createTestServer, send, validPayload } from './server.fixture';

describe('AgentHookServer parseSignal() alert field', () => {
    it.each(['quiet', 'raise'])(
        'rejects a wire packet carrying the Server-only alert %s',
        async (alert) => {
            const { server, socketPath } = await createTestServer();
            try {
                const token = server.register('terminal-1', 'launch-1', 'claude');
                const response = await send(
                    socketPath,
                    validPayload({ token, phase: 'attentionRequested', alert }),
                );
                expect(response).toBe('{"ok":false}\n');
            } finally {
                await server.close();
            }
        },
    );
});
