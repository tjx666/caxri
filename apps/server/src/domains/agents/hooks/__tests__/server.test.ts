import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { lstat, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

import { describe, expect, it, onTestFinished, vi } from 'vitest';

import type { AgentHookSignalResult } from '../server';
import { pruneStaleAgentHookSockets } from '../server';
import { anyHandlingMs, createTestServer, send, validPayload } from './server.fixture';

describe('AgentHookServer', () => {
    it('waits for one authenticated attention answer and rejects another launch', async () => {
        const onAttention = vi.fn(() => Promise.resolve({ decision: 'allow' as const }));
        const { server, socketPath, onSignal } = await createTestServer(undefined, onAttention);
        try {
            const token = server.register('terminal-1', 'launch-1', 'claude');
            const payload = {
                token,
                provider: 'claude',
                phase: 'attentionRequested',
                kind: 'attention',
                attentionKind: 'permission',
                toolName: 'Bash',
                summary: 'git status',
                questions: [],
            };
            expect(await send(socketPath, validPayload(payload))).toBe(
                '{"ok":true,"decision":"allow"}\n',
            );
            expect(onAttention).toHaveBeenCalledOnce();
            expect(onSignal).not.toHaveBeenCalled();
            expect(
                await send(socketPath, validPayload({ ...payload, launchId: 'other-launch' })),
            ).toBe('{"ok":false}\n');
        } finally {
            await server.close();
        }
    });
    describe('authorize()', () => {
        it('accepts empty Stop evidence only for the authenticated main Grok turn', async () => {
            const { server, socketPath, onSignal } = await createTestServer();
            try {
                const token = server.register('terminal-1', 'launch-1');
                const payload = {
                    token,
                    provider: 'grok',
                    phase: 'turnFinished',
                    agentResponseStop: true,
                };
                expect(await send(socketPath, validPayload(payload))).toBe('{"ok":true}\n');
                expect(onSignal).toHaveBeenCalledWith(
                    expect.objectContaining({ agentResponseStop: true }),
                );
                const rejected = await Promise.all(
                    [
                        { agentResponseStop: false },
                        { provider: 'claude' },
                        { phase: 'turnStarted' },
                        { agentId: 'child' },
                    ].map((extra) => send(socketPath, validPayload({ ...payload, ...extra }))),
                );
                expect(rejected).toEqual(Array.from({ length: 4 }, () => '{"ok":false}\n'));
            } finally {
                await server.close();
            }
        });
        it.each(['claude', 'codex'] as const)(
            'accepts authenticated %s task digests only on the owning main-agent phase',
            async (provider) => {
                const { server, socketPath, onSignal } = await createTestServer();
                try {
                    const token = server.register('terminal-1', 'launch-1', provider);
                    const payload = {
                        token,
                        provider,
                        phase: 'turnStarted',
                        agentTurnId: 'synthetic-turn',
                        agentPromptDigest: 'a'.repeat(64),
                    };
                    expect(await send(socketPath, validPayload(payload))).toBe('{"ok":true}\n');
                    expect(onSignal).toHaveBeenCalledWith(
                        expect.objectContaining({
                            provider,
                            agentPromptDigest: 'a'.repeat(64),
                            agentTurnId: 'synthetic-turn',
                        }),
                    );
                    expect(
                        await send(socketPath, validPayload({ ...payload, agentId: 'child' })),
                    ).toBe('{"ok":false}\n');
                    expect(
                        await send(socketPath, validPayload({ ...payload, phase: 'turnFinished' })),
                    ).toBe('{"ok":false}\n');
                } finally {
                    await server.close();
                }
            },
        );
        it('accepts a signal whose token, launchId, terminalId, provider, and schema all match the registration', async () => {
            const { server, socketPath, onDiagnostic, onSignal } = await createTestServer();
            try {
                const token = server.register('terminal-1', 'launch-1', 'codex');

                const response = await send(socketPath, validPayload({ token }));

                expect(response).toBe('{"ok":true}\n');
                expect(onSignal).toHaveBeenCalledWith(
                    expect.objectContaining({
                        launchId: 'launch-1',
                        terminalId: 'terminal-1',
                        provider: 'codex',
                        phase: 'turnFinished',
                    }),
                );
                expect(onDiagnostic).toHaveBeenCalledWith({
                    handlingMs: anyHandlingMs,
                    hasAgentCwd: false,
                    hasAgentSessionId: false,
                    hasAgentTurnId: false,
                    outcome: 'accepted',
                    phase: 'turnFinished',
                    provider: 'codex',
                    terminalId: 'terminal-1',
                    worktreeCreateIntent: false,
                });
            } finally {
                await server.close();
            }
        });

        it('accepts any provider matching the schema when the registration has no provider restriction', async () => {
            const { server, socketPath, onSignal } = await createTestServer();
            try {
                const token = server.register('terminal-1', 'launch-1');

                const response = await send(
                    socketPath,
                    validPayload({ token, provider: 'claude' }),
                );

                expect(response).toBe('{"ok":true}\n');
                expect(onSignal).toHaveBeenCalledOnce();
            } finally {
                await server.close();
            }
        });

        it('acknowledges an authenticated signal that the owning Terminal ignores', async () => {
            const { server, socketPath, onDiagnostic } = await createTestServer(
                vi.fn(() => ({ disposition: 'ignored', reason: 'terminalMissing' }) as const),
            );
            try {
                const token = server.register('terminal-1', 'launch-1');

                const response = await send(socketPath, validPayload({ token }));

                expect(response).toBe('{"ok":true,"ignored":true}\n');
                expect(onDiagnostic).toHaveBeenCalledWith({
                    handlingMs: anyHandlingMs,
                    hasAgentCwd: false,
                    hasAgentSessionId: false,
                    hasAgentTurnId: false,
                    outcome: 'ignored',
                    phase: 'turnFinished',
                    provider: 'codex',
                    reason: 'terminalMissing',
                    terminalId: 'terminal-1',
                    worktreeCreateIntent: false,
                });
            } finally {
                await server.close();
            }
        });

        it('rejects an unknown token', async () => {
            const { server, socketPath, onDiagnostic, onSignal } = await createTestServer();
            try {
                server.register('terminal-1', 'launch-1', 'codex');

                const response = await send(
                    socketPath,
                    validPayload({ token: 'unregistered-token' }),
                );

                expect(response).toBe('{"ok":false}\n');
                expect(onSignal).not.toHaveBeenCalled();
                expect(onDiagnostic).toHaveBeenCalledWith({
                    handlingMs: anyHandlingMs,
                    hasAgentSessionId: false,
                    outcome: 'rejected',
                    phase: 'turnFinished',
                    provider: 'codex',
                    reason: 'unknownToken',
                    terminalId: 'terminal-1',
                });
            } finally {
                await server.close();
            }
        });

        it('rejects a mismatched launchId', async () => {
            const { server, socketPath, onDiagnostic, onSignal } = await createTestServer();
            try {
                const token = server.register('terminal-1', 'launch-1', 'codex');

                const response = await send(
                    socketPath,
                    validPayload({ token, launchId: 'launch-2' }),
                );

                expect(response).toBe('{"ok":false}\n');
                expect(onSignal).not.toHaveBeenCalled();
                expect(onDiagnostic).toHaveBeenCalledWith(
                    expect.objectContaining({ outcome: 'rejected', reason: 'launchMismatch' }),
                );
            } finally {
                await server.close();
            }
        });

        it('rejects a mismatched terminalId', async () => {
            const { server, socketPath, onDiagnostic, onSignal } = await createTestServer();
            try {
                const token = server.register('terminal-1', 'launch-1', 'codex');

                const response = await send(
                    socketPath,
                    validPayload({ token, terminalId: 'terminal-2' }),
                );

                expect(response).toBe('{"ok":false}\n');
                expect(onSignal).not.toHaveBeenCalled();
                expect(onDiagnostic).toHaveBeenCalledWith(
                    expect.objectContaining({ outcome: 'rejected', reason: 'terminalMismatch' }),
                );
            } finally {
                await server.close();
            }
        });

        it('ignores (without rejecting) a mismatched provider when the registration is provider-restricted', async () => {
            // Benign nested-CLI case (inherited CAXRI_HOOK_* env): must be an "ok" reply, not a stderr rejection.
            const { server, socketPath, onDiagnostic, onSignal } = await createTestServer();
            try {
                const token = server.register('terminal-1', 'launch-1', 'codex');

                const response = await send(
                    socketPath,
                    validPayload({ token, provider: 'claude' }),
                );

                expect(response).toBe('{"ok":true,"ignored":true}\n');
                expect(onSignal).not.toHaveBeenCalled();
                expect(onDiagnostic).toHaveBeenCalledWith(
                    expect.objectContaining({ outcome: 'ignored', reason: 'providerMismatch' }),
                );
            } finally {
                await server.close();
            }
        });

        it('accepts a schema version older than the server expects but rejects one that is newer', async () => {
            // Older builds must accept a signal snapshotted with a lower schema (see authorizationOutcome's JSDoc).
            const { server, socketPath, onDiagnostic, onSignal } = await createTestServer();
            try {
                const token = server.register('terminal-1', 'launch-1', 'codex');

                const older = await send(socketPath, validPayload({ token, schemaVersion: 1 }));
                expect(older).toBe('{"ok":true}\n');
                expect(onSignal).toHaveBeenCalledOnce();

                const newer = await send(socketPath, validPayload({ token, schemaVersion: 3 }));
                expect(newer).toBe('{"ok":false}\n');
                expect(onDiagnostic).toHaveBeenCalledWith(
                    expect.objectContaining({ outcome: 'rejected', reason: 'schemaMismatch' }),
                );
            } finally {
                await server.close();
            }
        });

        it('rejects a token that was explicitly unregistered', async () => {
            const { server, socketPath, onSignal } = await createTestServer();
            try {
                const token = server.register('terminal-1', 'launch-1', 'codex');
                server.unregister(token);

                const response = await send(socketPath, validPayload({ token }));

                expect(response).toBe('{"ok":false}\n');
                expect(onSignal).not.toHaveBeenCalled();
            } finally {
                await server.close();
            }
        });

        it('rejects a signal when the authenticated downstream handler fails', async () => {
            const { server, socketPath, onDiagnostic } = await createTestServer(
                vi.fn(() => ({ disposition: 'rejected' }) as const),
            );
            try {
                const token = server.register('terminal-1', 'launch-1', 'codex');

                const response = await send(socketPath, validPayload({ token }));

                expect(response).toBe('{"ok":false}\n');
                expect(onDiagnostic).toHaveBeenCalledWith(
                    expect.objectContaining({ outcome: 'rejected', reason: 'downstreamRejected' }),
                );
            } finally {
                await server.close();
            }
        });

        it('waits for asynchronous downstream provenance before acknowledging the hook', async () => {
            const pending = Promise.withResolvers<AgentHookSignalResult>();
            const onSignal = vi.fn(() => pending.promise);
            const { server, socketPath } = await createTestServer(onSignal);
            try {
                const token = server.register('terminal-1', 'launch-1', 'codex');
                const response = send(socketPath, validPayload({ token }));
                await vi.waitFor(() => expect(onSignal).toHaveBeenCalledOnce());

                pending.resolve({ disposition: 'accepted' });

                await expect(response).resolves.toBe('{"ok":true}\n');
            } finally {
                await server.close();
            }
        });
    });

    describe('pruneStaleAgentHookSockets()', () => {
        // Socket paths must stay directly under `tmpdir()` (no extra nested directory): a Unix
        // domain socket path is bounded by `sockaddr_un.sun_path` (104 bytes on macOS), and an
        // `mkdtemp`-derived subdirectory pushes long profile-scoped names past that limit.

        it('removes a socket left by a dead PID and keeps the socket owned by the current process', async () => {
            const profileId = `prune-test-${randomBytes(3).toString('hex')}`;
            const deadPid = 2_147_483_646;
            const deadSocketPath = join(tmpdir(), `caxri-hooks-${profileId}-${deadPid}.sock`);
            const liveSocketPath = join(tmpdir(), `caxri-hooks-${profileId}-${process.pid}.sock`);
            const deadServer = createServer();
            const liveServer = createServer();
            deadServer.listen(deadSocketPath);
            liveServer.listen(liveSocketPath);
            await Promise.all([once(deadServer, 'listening'), once(liveServer, 'listening')]);

            try {
                await pruneStaleAgentHookSockets(tmpdir(), profileId);

                await expect(lstat(deadSocketPath)).rejects.toMatchObject({ code: 'ENOENT' });
                expect((await lstat(liveSocketPath)).isSocket()).toBe(true);
            } finally {
                await Promise.all([
                    new Promise<void>((resolve) => deadServer.close(() => resolve())),
                    new Promise<void>((resolve) => liveServer.close(() => resolve())),
                ]);
                await rm(liveSocketPath, { force: true });
            }
        });

        it('leaves a socket owned by a genuinely live, non-self PID intact', async () => {
            const profileId = `prune-live-${randomBytes(3).toString('hex')}`;
            const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60_000)'], {
                stdio: 'ignore',
            });
            await once(child, 'spawn');
            const livePid = child.pid;
            if (!livePid) throw new Error('the spawned child process did not report a PID');
            const socketPath = join(tmpdir(), `caxri-hooks-${profileId}-${livePid}.sock`);
            const server = createServer();
            server.listen(socketPath);
            await once(server, 'listening');

            try {
                await pruneStaleAgentHookSockets(tmpdir(), profileId);

                expect((await lstat(socketPath)).isSocket()).toBe(true);
            } finally {
                child.kill();
                await new Promise<void>((resolve) => server.close(() => resolve()));
                await rm(socketPath, { force: true });
            }
        });

        /**
         * The sweep used to stop after a fixed number of directory entries, so a stale socket was reclaimed only if it
         * happened to be reached before unrelated temp files exhausted the budget. A routine macOS `$TMPDIR` already
         * holds several thousand entries, which is what made the two removal assertions in this suite fail
         * intermittently — and, in production, what let a crashed Server's socket survive forever. The bound now counts
         * profile-owned candidates, so foreign entries cannot starve it however many there are.
         */
        it('reclaims a stale socket that unrelated directory entries would have crowded out', async () => {
            const suffix = randomBytes(2).toString('hex');
            // Short directory and profile names on purpose: a Unix domain socket path is bounded by
            // `sockaddr_un.sun_path` (104 bytes on macOS) and `tmpdir()` already spends ~49 of them.
            const directory = await mkdtemp(join(tmpdir(), 'cxh'));
            onTestFinished(() => rm(directory, { recursive: true, force: true }));
            const socketPath = join(directory, `caxri-hooks-p${suffix}-2147483646.sock`);
            await Promise.all(
                Array.from({ length: 200 }, (_, index) =>
                    writeFile(join(directory, `filler-${index}`), '', 'utf8'),
                ),
            );
            const server = createServer();
            server.listen(socketPath);
            await once(server, 'listening');

            try {
                // A candidate cap of 1 is enough for the single profile-owned socket; only a bound
                // that counted the 200 foreign entries too would run out before reaching it.
                await pruneStaleAgentHookSockets(directory, `p${suffix}`, process.pid, 1);

                await expect(lstat(socketPath)).rejects.toMatchObject({ code: 'ENOENT' });
            } finally {
                await new Promise<void>((resolve) => server.close(() => resolve()));
            }
        });

        it('ignores stale-looking sockets that belong to a different Caxri profile', async () => {
            const suffix = randomBytes(3).toString('hex');
            const foreignSocketPath = join(
                tmpdir(),
                `caxri-hooks-prune-foreign-${suffix}-2147483646.sock`,
            );
            const server = createServer();
            server.listen(foreignSocketPath);
            await once(server, 'listening');

            try {
                await pruneStaleAgentHookSockets(tmpdir(), `prune-under-test-${suffix}`);

                expect((await lstat(foreignSocketPath)).isSocket()).toBe(true);
            } finally {
                await new Promise<void>((resolve) => server.close(() => resolve()));
                await rm(foreignSocketPath, { force: true });
            }
        });
    });
});
