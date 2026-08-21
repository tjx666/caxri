import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { lstat, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createConnection, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { AgentHookServer, pruneStaleAgentHookSockets } from '../server';

const temporaryDirectories: string[] = [];
const SCHEMA_VERSIONS = { claude: 2, codex: 2 } as const;

afterEach(async () => {
    const pendingCleanup = [...temporaryDirectories];
    temporaryDirectories.length = 0;
    await Promise.all(pendingCleanup.map((path) => rm(path, { recursive: true, force: true })));
});

function validPayload(overrides: Record<string, unknown> = {}): string {
    return JSON.stringify({
        protocolVersion: 1,
        schemaVersion: 2,
        launchId: 'launch-1',
        terminalId: 'terminal-1',
        provider: 'codex',
        phase: 'turnFinished',
        token: 'placeholder-token',
        ...overrides,
    });
}

/**
 * Connects to the hook socket, writes the raw wire payload, and collects whatever the server writes back before the
 * connection closes. An oversized payload makes the server destroy the socket without ever replying, so callers must
 * tolerate an empty response.
 */
async function send(socketPath: string, payload: string): Promise<string> {
    return new Promise((resolve, reject) => {
        const socket = createConnection(socketPath);
        let response = '';
        socket.setEncoding('utf8');
        socket.on('connect', () => socket.end(payload));
        socket.on('data', (chunk: string) => {
            response += chunk;
        });
        socket.on('close', () => resolve(response));
        socket.on('error', reject);
    });
}

async function createTestServer(onSignal = vi.fn(() => true)) {
    const directory = await mkdtemp(join(tmpdir(), 'caxri-agent-hook-server-'));
    temporaryDirectories.push(directory);
    const socketPath = join(directory, 'hooks.sock');
    const server = new AgentHookServer(socketPath, SCHEMA_VERSIONS, onSignal);
    await server.start();
    return { server, socketPath, onSignal };
}

describe('AgentHookServer', () => {
    describe('authorize()', () => {
        it('accepts a signal whose token, launchId, terminalId, provider, and schema all match the registration', async () => {
            const { server, socketPath, onSignal } = await createTestServer();
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

        it('rejects an unknown token', async () => {
            const { server, socketPath, onSignal } = await createTestServer();
            try {
                server.register('terminal-1', 'launch-1', 'codex');

                const response = await send(
                    socketPath,
                    validPayload({ token: 'unregistered-token' }),
                );

                expect(response).toBe('{"ok":false}\n');
                expect(onSignal).not.toHaveBeenCalled();
            } finally {
                await server.close();
            }
        });

        it('rejects a mismatched launchId', async () => {
            const { server, socketPath, onSignal } = await createTestServer();
            try {
                const token = server.register('terminal-1', 'launch-1', 'codex');

                const response = await send(
                    socketPath,
                    validPayload({ token, launchId: 'launch-2' }),
                );

                expect(response).toBe('{"ok":false}\n');
                expect(onSignal).not.toHaveBeenCalled();
            } finally {
                await server.close();
            }
        });

        it('rejects a mismatched terminalId', async () => {
            const { server, socketPath, onSignal } = await createTestServer();
            try {
                const token = server.register('terminal-1', 'launch-1', 'codex');

                const response = await send(
                    socketPath,
                    validPayload({ token, terminalId: 'terminal-2' }),
                );

                expect(response).toBe('{"ok":false}\n');
                expect(onSignal).not.toHaveBeenCalled();
            } finally {
                await server.close();
            }
        });

        it('rejects a mismatched provider when the registration is provider-restricted', async () => {
            const { server, socketPath, onSignal } = await createTestServer();
            try {
                const token = server.register('terminal-1', 'launch-1', 'codex');

                const response = await send(
                    socketPath,
                    validPayload({ token, provider: 'claude' }),
                );

                expect(response).toBe('{"ok":false}\n');
                expect(onSignal).not.toHaveBeenCalled();
            } finally {
                await server.close();
            }
        });

        it('rejects a schema version that no longer matches the configured provider schema', async () => {
            const { server, socketPath, onSignal } = await createTestServer();
            try {
                const token = server.register('terminal-1', 'launch-1', 'codex');

                const response = await send(socketPath, validPayload({ token, schemaVersion: 1 }));

                expect(response).toBe('{"ok":false}\n');
                expect(onSignal).not.toHaveBeenCalled();
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
    });

    describe('parseSignal()', () => {
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
        ])('rejects a signal that is %s', async (_description, payload) => {
            const { server, socketPath, onSignal } = await createTestServer();
            try {
                server.register('t', 'l', 'codex');

                const response = await send(socketPath, payload);

                expect(response).toBe('{"ok":false}\n');
                expect(onSignal).not.toHaveBeenCalled();
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

        it('destroys the connection instead of parsing an oversized payload', async () => {
            const { server, socketPath, onSignal } = await createTestServer();
            try {
                const token = server.register('terminal-1', 'launch-1', 'codex');
                const oversized = validPayload({ token, terminalId: 'x'.repeat(5_000) });

                const response = await send(socketPath, oversized);

                expect(response).toBe('');
                expect(onSignal).not.toHaveBeenCalled();
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
         * intermittently — and, in production, what let a crashed Runtime's socket survive forever. The bound now
         * counts profile-owned candidates, so foreign entries cannot starve it however many there are.
         */
        it('reclaims a stale socket that unrelated directory entries would have crowded out', async () => {
            const suffix = randomBytes(2).toString('hex');
            // Short directory and profile names on purpose: a Unix domain socket path is bounded by
            // `sockaddr_un.sun_path` (104 bytes on macOS) and `tmpdir()` already spends ~49 of them.
            const directory = await mkdtemp(join(tmpdir(), 'cxh'));
            temporaryDirectories.push(directory);
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
