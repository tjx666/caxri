import { describe, expect, it } from 'vitest';

import { createTestServer, send, validPayload } from './server.fixture';

describe('AgentHookServer Antigravity Stop turn', () => {
    it("gives a main-Agent Stop the turn its launch's first call opened in the same conversation", async () => {
        const { server, socketPath, onSignal } = await createTestServer();
        try {
            const token = server.register('terminal-1', 'launch-1', 'antigravity');
            const signal = (overrides: Record<string, unknown>) =>
                send(
                    socketPath,
                    validPayload({
                        token,
                        provider: 'antigravity',
                        agentSessionId: 'conversation-1',
                        ...overrides,
                    }),
                );

            await signal({ phase: 'turnStarted', agentTurnId: 'step-4' });
            await signal({ phase: 'turnFinished', agentId: 'subagent-1' });
            await signal({ phase: 'turnFinished', agentSessionId: 'conversation-2' });
            await signal({ phase: 'turnFinished' });
            // The turn is consumed, so a repeated Stop names none.
            await signal({ phase: 'turnFailed' });

            expect(onSignal.mock.calls.map(([call]) => call.agentTurnId)).toEqual([
                'step-4',
                undefined,
                undefined,
                'step-4',
                undefined,
            ]);
        } finally {
            await server.close();
        }
    });

    it('leaves another provider and a turn without an id unchanged', async () => {
        const { server, socketPath, onSignal } = await createTestServer();
        try {
            const grok = server.register('terminal-1', 'launch-1', 'grok');
            await send(
                socketPath,
                validPayload({
                    token: grok,
                    provider: 'grok',
                    phase: 'turnStarted',
                    agentTurnId: 'prompt-1',
                }),
            );
            await send(socketPath, validPayload({ token: grok, provider: 'grok' }));

            const agy = server.register('terminal-2', 'launch-2', 'antigravity');
            const antigravity = (phase: string) =>
                send(
                    socketPath,
                    validPayload({
                        token: agy,
                        launchId: 'launch-2',
                        terminalId: 'terminal-2',
                        provider: 'antigravity',
                        phase,
                    }),
                );
            await antigravity('turnStarted');
            await antigravity('turnFinished');

            expect(onSignal.mock.calls.map(([call]) => call.agentTurnId)).toEqual([
                'prompt-1',
                undefined,
                undefined,
                undefined,
            ]);
        } finally {
            await server.close();
        }
    });
});
