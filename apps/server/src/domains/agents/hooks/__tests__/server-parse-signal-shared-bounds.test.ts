import { describe, expect, it } from 'vitest';

import { anyHandlingMs, createTestServer, send, validPayload } from './server.fixture';

/**
 * Known and unknown phases share one identity and cwd validator in `server.ts`; this table pins that both paths reject
 * the same malformed fields with the same reason.
 */
describe('AgentHookServer shared signal bounds', () => {
    it.each(
        ['turnFinished', 'sessionCompacted'].flatMap((phase) =>
            [
                ['agentId', '../outside', 'invalidAgentId'],
                ['agentSessionId', 1, 'invalidAgentSessionId'],
                ['agentSessionId', 'x'.repeat(257), 'invalidAgentSessionId'],
                ['agentTurnId', '../outside', 'invalidAgentTurnId'],
                ['agentCwd', 'relative/path', 'invalidAgentCwd'],
                ['agentCwd', '', 'invalidAgentCwd'],
                ['agentCwd', '/tmp/a\0b', 'invalidAgentCwd'],
            ].map(([field, value, reason]) => ({ phase, field, value, reason })),
        ),
    )(
        'applies the shared identity and cwd bounds to $phase: $field=$value',
        async ({ phase, field, value, reason }) => {
            const { server, socketPath, onDiagnostic, onSignal } = await createTestServer();
            try {
                const token = server.register('terminal-1', 'launch-1', 'codex');
                const response = await send(
                    socketPath,
                    validPayload({ token, phase, [field as string]: value }),
                );

                expect(response).toBe('{"ok":false}\n');
                expect(onSignal).not.toHaveBeenCalled();
                expect(onDiagnostic).toHaveBeenCalledWith({
                    handlingMs: anyHandlingMs,
                    outcome: 'rejected',
                    reason,
                });
            } finally {
                await server.close();
            }
        },
    );
});
