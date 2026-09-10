import { once } from 'node:events';
import { createConnection } from 'node:net';

import { describe, expect, it } from 'vitest';

import type { AgentHookSignalRejectionReason } from '../server';
import { anyHandlingMs, createTestServer, send, validPayload } from './server.fixture';

/**
 * Maps a rejection case's description to the reason the wire validator reports for it. Keeping this beside the case
 * table lets one `it.each` cover every field without a nested conditional that grows with each new bounded field.
 */
function expectedRejectionReason(description: string): AgentHookSignalRejectionReason {
    if (description === 'invalid JSON') return 'invalidJson';
    if (description.includes('agentCwd')) return 'invalidAgentCwd';
    if (description.includes('agentId')) return 'invalidAgentId';
    if (description.includes('agentSessionId')) return 'invalidAgentSessionId';
    if (description.includes('agentToolUseId') && description.includes('path-like'))
        return 'invalidAgentToolUseId';
    if (description.includes('agentTurnId')) return 'invalidAgentTurnId';
    return 'invalidSignal';
}

describe('AgentHookServer parseSignal()', () => {
    it.each([
        { phase: 'turnFailed', accepted: true },
        { phase: 'turnFinished', accepted: true },
        { phase: 'turnStarted', accepted: false },
        { phase: 'turnFailed', agentId: 'child', accepted: false },
    ])(
        'validates Grok failure phase and main-agent scope (%#)',
        async ({ accepted, ...fields }) => {
            const { server, socketPath } = await createTestServer();
            try {
                const token = server.register('terminal-1', 'launch-1', 'grok');
                const response = await send(
                    socketPath,
                    validPayload({
                        token,
                        provider: 'grok',
                        agentFailure: 'rate_limit',
                        ...fields,
                    }),
                );
                expect(response).toBe(accepted ? '{"ok":true}\n' : '{"ok":false}\n');
            } finally {
                await server.close();
            }
        },
    );
    it.each([
        { agentResponseByteLength: 16, accepted: true },
        { agentResponseByteLength: -1, accepted: false },
        { agentResponseByteLength: 1.5, accepted: false },
        { agentResponseByteLength: 1_048_577, accepted: false },
        { agentResponseByteLength: 16, agentId: 'native-child', accepted: false },
    ])('validates Grok response lengths (%#)', async ({ accepted, ...fields }) => {
        const { server, socketPath } = await createTestServer();
        try {
            const token = server.register('terminal-1', 'launch-1', 'grok');
            const response = await send(
                socketPath,
                validPayload({
                    token,
                    provider: 'grok',
                    phase: 'turnFinished',
                    agentResponseDigest: 'a'.repeat(64),
                    ...fields,
                }),
            );
            expect(response).toBe(accepted ? '{"ok":true}\n' : '{"ok":false}\n');
        } finally {
            await server.close();
        }
    });
    it.each([
        { phase: 'turnFinished', agentResponseDigest: 'a'.repeat(64), accepted: true },
        { phase: 'turnStarted', agentPromptDigest: 'b'.repeat(64), accepted: true },
        { phase: 'turnFinished', agentPromptDigest: 'b'.repeat(64), accepted: false },
        { phase: 'turnFinished', agentResponseDigest: 'invalid', accepted: false },
        {
            phase: 'turnFinished',
            agentResponseDigest: 'a'.repeat(64),
            agentId: 'subagent',
            accepted: false,
        },
    ])(
        'validates delegation digests without adding them to diagnostics: %j',
        async ({ accepted, ...fields }) => {
            const { server, socketPath, onSignal, onDiagnostic } = await createTestServer();
            try {
                const token = server.register('terminal-1', 'launch-1', 'claude');
                const response = await send(
                    socketPath,
                    validPayload({ token, provider: 'claude', ...fields }),
                );
                expect(response).toBe(accepted ? '{"ok":true}\n' : '{"ok":false}\n');
                expect(onSignal).toHaveBeenCalledTimes(accepted ? 1 : 0);
                expect(JSON.stringify(onDiagnostic.mock.calls)).not.toContain('a'.repeat(64));
                expect(JSON.stringify(onDiagnostic.mock.calls)).not.toContain('b'.repeat(64));
            } finally {
                await server.close();
            }
        },
    );

    it.each([
        ['invalid JSON', 'not-json'],
        ['a JSON array', '[]'],
        ['a JSON primitive', '"hello"'],
        [
            'a wrong protocolVersion',
            JSON.stringify({
                protocolVersion: 2,
                schemaVersion: 2,
                launchId: 'l',
                terminalId: 't',
                provider: 'codex',
                phase: 'turnFinished',
                token: 'tok',
            }),
        ],
        [
            'a non-numeric schemaVersion',
            JSON.stringify({
                protocolVersion: 1,
                schemaVersion: '2',
                launchId: 'l',
                terminalId: 't',
                provider: 'codex',
                phase: 'turnFinished',
                token: 'tok',
            }),
        ],
        [
            'a missing launchId',
            JSON.stringify({
                protocolVersion: 1,
                schemaVersion: 2,
                terminalId: 't',
                provider: 'codex',
                phase: 'turnFinished',
                token: 'tok',
            }),
        ],
        [
            'a non-string terminalId',
            JSON.stringify({
                protocolVersion: 1,
                schemaVersion: 2,
                launchId: 'l',
                terminalId: 1,
                provider: 'codex',
                phase: 'turnFinished',
                token: 'tok',
            }),
        ],
        [
            'a non-string token',
            JSON.stringify({
                protocolVersion: 1,
                schemaVersion: 2,
                launchId: 'l',
                terminalId: 't',
                provider: 'codex',
                phase: 'turnFinished',
                token: 1,
            }),
        ],
        [
            'an unknown provider',
            JSON.stringify({
                protocolVersion: 1,
                schemaVersion: 2,
                launchId: 'l',
                terminalId: 't',
                provider: 'bogus',
                phase: 'turnFinished',
                token: 'tok',
            }),
        ],
        [
            'an unknown phase',
            JSON.stringify({
                protocolVersion: 1,
                schemaVersion: 2,
                launchId: 'l',
                terminalId: 't',
                provider: 'codex',
                phase: 'bogus',
                token: 'tok',
            }),
        ],
        [
            'a path-like agentId',
            JSON.stringify({
                protocolVersion: 1,
                schemaVersion: 2,
                launchId: 'l',
                terminalId: 't',
                provider: 'codex',
                phase: 'turnFinished',
                token: 'tok',
                agentId: '../outside',
            }),
        ],
        [
            'a non-string agentSessionId',
            JSON.stringify({
                protocolVersion: 1,
                schemaVersion: 2,
                launchId: 'l',
                terminalId: 't',
                provider: 'codex',
                phase: 'turnFinished',
                token: 'tok',
                agentSessionId: 1,
            }),
        ],
        [
            'an overlong agentSessionId',
            JSON.stringify({
                protocolVersion: 1,
                schemaVersion: 2,
                launchId: 'l',
                terminalId: 't',
                provider: 'codex',
                phase: 'turnFinished',
                token: 'tok',
                agentSessionId: 'x'.repeat(257),
            }),
        ],
        [
            'a path-like agentSessionId',
            JSON.stringify({
                protocolVersion: 1,
                schemaVersion: 2,
                launchId: 'l',
                terminalId: 't',
                provider: 'codex',
                phase: 'turnFinished',
                token: 'tok',
                agentSessionId: '../outside',
            }),
        ],
        [
            'a path-like agentTurnId',
            JSON.stringify({
                protocolVersion: 1,
                schemaVersion: 2,
                launchId: 'l',
                terminalId: 't',
                provider: 'codex',
                phase: 'turnStarted',
                token: 'tok',
                agentTurnId: '../outside',
            }),
        ],
        [
            'a false worktreeCreateIntent',
            JSON.stringify({
                protocolVersion: 1,
                schemaVersion: 2,
                launchId: 'l',
                terminalId: 't',
                provider: 'codex',
                phase: 'shellToolFinished',
                token: 'tok',
                worktreeCreateIntent: false,
            }),
        ],
        [
            'worktreeCreateIntent on a non-shell phase',
            JSON.stringify({
                protocolVersion: 1,
                schemaVersion: 2,
                launchId: 'l',
                terminalId: 't',
                provider: 'codex',
                phase: 'turnFinished',
                token: 'tok',
                worktreeCreateIntent: true,
            }),
        ],
        [
            'worktreeCreateIntent without agentToolUseId',
            JSON.stringify({
                protocolVersion: 1,
                schemaVersion: 2,
                launchId: 'l',
                terminalId: 't',
                provider: 'codex',
                phase: 'shellToolStarted',
                token: 'tok',
                worktreeCreateIntent: true,
            }),
        ],
        [
            'a path-like agentToolUseId',
            JSON.stringify({
                protocolVersion: 1,
                schemaVersion: 2,
                launchId: 'l',
                terminalId: 't',
                provider: 'codex',
                phase: 'shellToolStarted',
                token: 'tok',
                agentToolUseId: '../outside',
                worktreeCreateIntent: true,
            }),
        ],
        [
            'a relative agentCwd',
            JSON.stringify({
                protocolVersion: 1,
                schemaVersion: 2,
                launchId: 'l',
                terminalId: 't',
                provider: 'codex',
                phase: 'turnStarted',
                token: 'tok',
                agentCwd: '../outside',
            }),
        ],
        [
            'a non-string agentCwd',
            JSON.stringify({
                protocolVersion: 1,
                schemaVersion: 2,
                launchId: 'l',
                terminalId: 't',
                provider: 'codex',
                phase: 'turnStarted',
                token: 'tok',
                agentCwd: 1,
            }),
        ],
        [
            'an empty agentCwd',
            JSON.stringify({
                protocolVersion: 1,
                schemaVersion: 2,
                launchId: 'l',
                terminalId: 't',
                provider: 'codex',
                phase: 'turnStarted',
                token: 'tok',
                agentCwd: '',
            }),
        ],
        [
            'an overlong agentCwd',
            JSON.stringify({
                protocolVersion: 1,
                schemaVersion: 2,
                launchId: 'l',
                terminalId: 't',
                provider: 'codex',
                phase: 'turnStarted',
                token: 'tok',
                agentCwd: `/${'x'.repeat(1_024)}`,
            }),
        ],
        [
            'an agentCwd containing NUL',
            JSON.stringify({
                protocolVersion: 1,
                schemaVersion: 2,
                launchId: 'l',
                terminalId: 't',
                provider: 'codex',
                phase: 'turnStarted',
                token: 'tok',
                agentCwd: '/repo\0/etc',
            }),
        ],
    ])('rejects a signal that is %s', async (description, payload) => {
        const { server, socketPath, onDiagnostic, onSignal } = await createTestServer();
        try {
            server.register('t', 'l', 'codex');

            const response = await send(socketPath, payload);

            expect(response).toBe('{"ok":false}\n');
            expect(onSignal).not.toHaveBeenCalled();
            expect(onDiagnostic).toHaveBeenCalledWith({
                handlingMs: anyHandlingMs,
                outcome: 'rejected',
                reason: expectedRejectionReason(description),
            });
        } finally {
            await server.close();
        }
    });

    it('accepts a well-formed signal matching every required wire field', async () => {
        const { server, socketPath } = await createTestServer();
        try {
            const token = server.register('terminal-1', 'launch-1', 'codex');

            const response = await send(socketPath, validPayload({ token }));

            expect(response).toBe('{"ok":true}\n');
        } finally {
            await server.close();
        }
    });

    it('forwards an optional provider session identifier to the signal consumer', async () => {
        const { server, socketPath, onSignal } = await createTestServer();
        try {
            const token = server.register('terminal-1', 'launch-1', 'codex');

            const response = await send(
                socketPath,
                validPayload({ token, agentSessionId: 'provider-session-9' }),
            );

            expect(response).toBe('{"ok":true}\n');
            expect(onSignal).toHaveBeenCalledWith(
                expect.objectContaining({ agentSessionId: 'provider-session-9' }),
            );
        } finally {
            await server.close();
        }
    });

    it('forwards an optional provider turn identifier to the signal consumer', async () => {
        const { server, socketPath, onSignal } = await createTestServer();
        try {
            const token = server.register('terminal-1', 'launch-1', 'codex');

            const response = await send(
                socketPath,
                validPayload({ token, agentTurnId: 'provider-turn-9' }),
            );

            expect(response).toBe('{"ok":true}\n');
            expect(onSignal).toHaveBeenCalledWith(
                expect.objectContaining({ agentTurnId: 'provider-turn-9' }),
            );
        } finally {
            await server.close();
        }
    });

    it('forwards only paired tool identity and worktree-create intent on a Bash hook', async () => {
        const { server, socketPath, onSignal } = await createTestServer();
        try {
            const token = server.register('terminal-1', 'launch-1', 'codex');

            const response = await send(
                socketPath,
                validPayload({
                    phase: 'shellToolFinished',
                    token,
                    agentToolUseId: 'tool-use-9',
                    worktreeCreateIntent: true,
                }),
            );

            expect(response).toBe('{"ok":true}\n');
            expect(onSignal).toHaveBeenCalledWith(
                expect.objectContaining({
                    phase: 'shellToolFinished',
                    agentToolUseId: 'tool-use-9',
                    worktreeCreateIntent: true,
                }),
            );
        } finally {
            await server.close();
        }
    });

    it('forwards a bounded absolute agentCwd on a non-shell phase', async () => {
        const { server, socketPath, onSignal } = await createTestServer();
        try {
            const token = server.register('terminal-1', 'launch-1', 'codex');

            const response = await send(
                socketPath,
                validPayload({
                    token,
                    agentCwd: '/repo-worktrees/feature',
                    phase: 'turnStarted',
                }),
            );

            expect(response).toBe('{"ok":true}\n');
            expect(onSignal).toHaveBeenCalledWith(
                expect.objectContaining({ agentCwd: '/repo-worktrees/feature' }),
            );
        } finally {
            await server.close();
        }
    });

    it('forwards a bounded subagent identifier without provider content', async () => {
        const { server, socketPath, onSignal } = await createTestServer();
        try {
            const token = server.register('terminal-1', 'launch-1', 'codex');

            const response = await send(
                socketPath,
                validPayload({
                    token,
                    agentId: 'agent-9',
                    phase: 'toolBatchFinished',
                }),
            );

            expect(response).toBe('{"ok":true}\n');
            expect(onSignal).toHaveBeenCalledWith(expect.objectContaining({ agentId: 'agent-9' }));
        } finally {
            await server.close();
        }
    });

    it('destroys the connection instead of parsing an oversized payload', async () => {
        const { server, socketPath, onDiagnostic, onSignal } = await createTestServer();
        try {
            const token = server.register('terminal-1', 'launch-1', 'codex');
            const oversized = validPayload({ token, terminalId: 'x'.repeat(5_000) });

            const response = await send(socketPath, oversized);

            expect(response).toBe('');
            expect(onSignal).not.toHaveBeenCalled();
            expect(onDiagnostic).toHaveBeenCalledTimes(1);
            expect(onDiagnostic).toHaveBeenCalledWith({
                handlingMs: anyHandlingMs,
                outcome: 'rejected',
                reason: 'payloadTooLarge',
            });
        } finally {
            await server.close();
        }
    });

    it('diagnoses a client that never finishes its signal', async () => {
        const { server, socketPath, onDiagnostic } = await createTestServer();
        try {
            const socket = createConnection(socketPath);
            await once(socket, 'connect');

            await once(socket, 'close');

            expect(onDiagnostic).toHaveBeenCalledWith({
                outcome: 'rejected',
                reason: 'transportTimeout',
            });
            expect(onDiagnostic).toHaveBeenCalledTimes(1);
        } finally {
            await server.close();
        }
    });
});
