import { describe, expect, it } from 'vitest';

import { anyHandlingMs, createTestServer, send, validPayload } from './server.fixture';

describe('AgentHookServer parseSignal() worktreeCreatePath', () => {
    it.each([
        ['relative', { worktreeCreatePath: 'relative/worktree' }],
        ['not normalized', { worktreeCreatePath: '/repo/../worktree' }],
        ['the filesystem root', { worktreeCreatePath: '/' }],
        ['oversized', { worktreeCreatePath: `/${'a'.repeat(1_100)}` }],
        ['carrying a NUL', { worktreeCreatePath: '/repo/work\0tree' }],
        ['not a string', { worktreeCreatePath: 7 }],
        ['sent without worktreeCreateIntent', { worktreeCreateIntent: undefined }],
    ])('rejects a worktreeCreatePath that is %s', async (_label, overrides) => {
        const { server, socketPath, onDiagnostic, onSignal } = await createTestServer();
        try {
            const token = server.register('terminal-1', 'launch-1', 'codex');
            const response = await send(
                socketPath,
                validPayload({
                    phase: 'shellToolStarted',
                    token,
                    agentToolUseId: 'tool-use-1',
                    worktreeCreateIntent: true,
                    worktreeCreatePath: '/repo-worktrees/feature',
                    ...overrides,
                }),
            );

            expect(response).toBe('{"ok":false}\n');
            expect(onSignal).not.toHaveBeenCalled();
            expect(onDiagnostic).toHaveBeenCalledWith({
                handlingMs: anyHandlingMs,
                outcome: 'rejected',
                reason: 'invalidSignal',
            });
        } finally {
            await server.close();
        }
    });

    it('forwards the normalized absolute worktree path of a classified Bash hook', async () => {
        const { server, socketPath, onSignal } = await createTestServer();
        try {
            const token = server.register('terminal-1', 'launch-1', 'codex');

            const response = await send(
                socketPath,
                validPayload({
                    phase: 'shellToolStarted',
                    token,
                    agentToolUseId: 'tool-use-9',
                    worktreeCreateIntent: true,
                    worktreeCreatePath: '/repo-worktrees/feature',
                }),
            );

            expect(response).toBe('{"ok":true}\n');
            expect(onSignal).toHaveBeenCalledWith(
                expect.objectContaining({ worktreeCreatePath: '/repo-worktrees/feature' }),
            );
        } finally {
            await server.close();
        }
    });
});
