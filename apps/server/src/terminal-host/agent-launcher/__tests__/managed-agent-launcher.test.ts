import { Buffer } from 'node:buffer';
import type { ChildProcess } from 'node:child_process';
import { access, mkdtemp, readFile, realpath, rm, stat } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import process from 'node:process';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { runManagedAgentLauncher } from '../client';
import {
    parseManagedAgentLauncherProcessArguments,
    runManagedAgentLauncherProcess,
} from '../process';
import type { ManagedAgentLauncherEvent, ManagedAgentLaunchPlan } from '../protocol';
import { MANAGED_AGENT_LAUNCHER_FLAG, managedAgentLauncherEnvironmentNames } from '../protocol';
import { ManagedAgentLauncherServer } from '../server';
import { managedAgentLauncherSocketPath } from '../socket-path';

const temporaryDirectories: string[] = [];
const servers: ManagedAgentLauncherServer[] = [];

afterEach(async () => {
    const pendingServers = [...servers];
    servers.length = 0;
    await Promise.all(pendingServers.map((server) => server.close()));
    const pendingDirectories = [...temporaryDirectories];
    temporaryDirectories.length = 0;
    await Promise.all(
        pendingDirectories.map((directory) => rm(directory, { recursive: true, force: true })),
    );
});

async function createTestServer(onEvent?: (event: ManagedAgentLauncherEvent) => void) {
    const directory = await mkdtemp(join(tmpdir(), 'caxri-managed-agent-launcher-'));
    temporaryDirectories.push(directory);
    const socketPath = join(directory, 'launcher.sock');
    const server = new ManagedAgentLauncherServer({
        socketPath,
        runtimePath: process.execPath,
        entryPath: join(directory, 'terminal-host.js'),
        onEvent,
        claimTimeoutMs: 100,
        terminationGraceMs: 50,
    });
    servers.push(server);
    await server.start();
    return { directory, server, socketPath };
}

function immediateExitPlan(cwd: string): ManagedAgentLaunchPlan {
    return {
        executable: process.execPath,
        args: ['-e', 'process.exit(0)'],
        environment: {},
        cwd,
    };
}

function isProcessAlive(processId: number): boolean {
    try {
        process.kill(processId, 0);
        return true;
    } catch {
        return false;
    }
}

async function rawClaim(
    socketPath: string,
    launchId: string,
    token: string,
): Promise<{ response: string; close(): Promise<void> }> {
    const socket = createConnection(socketPath);
    let response = '';
    let isFirstLineResolved = false;
    const { promise: firstLine, resolve: resolveFirstLine } = Promise.withResolvers<void>();
    const closed = new Promise<void>((resolve) => {
        socket.once('close', resolve);
    });
    socket.setEncoding('utf8');
    socket.once('connect', () => {
        socket.write(`${JSON.stringify({ type: 'claim', launchId, token })}\n`);
    });
    socket.on('data', (chunk: string) => {
        response += chunk;
        if (!isFirstLineResolved && response.includes('\n')) {
            isFirstLineResolved = true;
            resolveFirstLine();
        }
    });
    socket.once('error', () => {
        if (isFirstLineResolved) {
            return;
        }

        isFirstLineResolved = true;
        resolveFirstLine();
    });
    socket.once('close', () => {
        if (isFirstLineResolved) {
            return;
        }

        isFirstLineResolved = true;
        resolveFirstLine();
    });
    await firstLine;
    return {
        response,
        async close() {
            socket.destroy();
            await closed;
        },
    };
}

describe('ManagedAgentLauncherServer', () => {
    it('waits for the in-flight PTY write callback before closing a lost handoff', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-pending-agent-drain-'));
        temporaryDirectories.push(directory);
        const closeOnLostDrain = vi.fn();
        const ready = Promise.withResolvers<void>();
        const beforeExitAck = vi.fn(() => ({
            ready: ready.promise,
            resumeAfterDrain: vi.fn(),
            closeOnLostDrain,
        }));
        const socketPath = join(directory, 'launcher.sock');
        const server = new ManagedAgentLauncherServer({
            socketPath,
            runtimePath: process.execPath,
            entryPath: join(directory, 'launcher.js'),
            beforeExitAck,
        });
        servers.push(server);
        await server.start();
        const prepared = server.prepare({
            terminalId: 'terminal-pending-drain',
            launchId: 'launch-pending-drain',
            plan: immediateExitPlan(directory),
        });
        const socket = createConnection(socketPath);
        let response = '';
        socket.setEncoding('utf8');
        socket.on('data', (chunk: string) => {
            response += chunk;
        });
        socket.once('connect', () =>
            socket.write(
                `${JSON.stringify({
                    type: 'claim',
                    launchId: 'launch-pending-drain',
                    token: prepared.environment.CAXRI_AGENT_LAUNCHER_TOKEN,
                })}\n`,
            ),
        );
        try {
            await vi.waitFor(() => expect(response).toContain('"executable"'));
            socket.write(`${JSON.stringify({ type: 'started', processId: 12345 })}\n`);
            await prepared.started;
            socket.write(`${JSON.stringify({ type: 'exited', exitCode: 0, signal: null })}\n`);
            await vi.waitFor(() => expect(beforeExitAck).toHaveBeenCalledOnce());
            const closed = new Promise<void>((resolve) => socket.once('close', () => resolve()));
            socket.destroy();
            await closed;
            expect(closeOnLostDrain).not.toHaveBeenCalled();
            expect(() =>
                server.prepare({
                    terminalId: 'terminal-pending-drain',
                    launchId: 'launch-too-early',
                    plan: immediateExitPlan(directory),
                }),
            ).toThrow('Invalid or duplicate managed Agent launch identity');
            ready.resolve();
            await vi.waitFor(() => expect(closeOnLostDrain).toHaveBeenCalledOnce());
            expect(() =>
                server.prepare({
                    terminalId: 'terminal-pending-drain',
                    launchId: 'launch-after-barrier',
                    plan: immediateExitPlan(directory),
                }),
            ).not.toThrow();
        } finally {
            ready.resolve();
            socket.destroy();
        }
    });

    it('closes the captured PTY when exit is acknowledged but input drain is not', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-lost-agent-drain-'));
        temporaryDirectories.push(directory);
        const resumeAfterDrain = vi.fn();
        const closeOnLostDrain = vi.fn();
        const socketPath = join(directory, 'launcher.sock');
        const server = new ManagedAgentLauncherServer({
            socketPath,
            runtimePath: process.execPath,
            entryPath: join(directory, 'launcher.js'),
            beforeExitAck: () => ({ ready: Promise.resolve(), resumeAfterDrain, closeOnLostDrain }),
        });
        servers.push(server);
        await server.start();
        const prepared = server.prepare({
            terminalId: 'terminal-lost-drain',
            launchId: 'launch-lost-drain',
            plan: immediateExitPlan(directory),
        });
        const socket = createConnection(socketPath);
        let response = '';
        socket.setEncoding('utf8');
        socket.on('data', (chunk: string) => {
            response += chunk;
        });
        socket.once('connect', () => {
            socket.write(
                `${JSON.stringify({
                    type: 'claim',
                    launchId: 'launch-lost-drain',
                    token: prepared.environment.CAXRI_AGENT_LAUNCHER_TOKEN,
                })}\n`,
            );
        });
        try {
            await vi.waitFor(() => expect(response).toContain('"executable"'));
            socket.write(`${JSON.stringify({ type: 'started', processId: 12345 })}\n`);
            await prepared.started;
            socket.write(`${JSON.stringify({ type: 'exited', exitCode: 0, signal: null })}\n`);
            await vi.waitFor(() => expect(response).toContain('"exitAck"'));
            socket.destroy();
            await vi.waitFor(() => expect(closeOnLostDrain).toHaveBeenCalledOnce());
            expect(resumeAfterDrain).not.toHaveBeenCalled();
            expect(() =>
                server.prepare({
                    terminalId: 'terminal-lost-drain',
                    launchId: 'launch-after-loss',
                    plan: immediateExitPlan(directory),
                }),
            ).not.toThrow();
        } finally {
            socket.destroy();
        }
    });

    it('creates a mode-0600 socket and returns only the five launcher environment entries', async () => {
        const { directory, server, socketPath } = await createTestServer();

        const prepared = server.prepare({
            terminalId: 'terminal-1',
            launchId: 'launch-1',
            plan: immediateExitPlan(directory),
        });

        expect((await stat(socketPath)).mode & 0o777).toBe(0o600);
        expect(
            Object.keys(prepared.environment).toSorted((left, right) => left.localeCompare(right)),
        ).toEqual(
            managedAgentLauncherEnvironmentNames.toSorted((left, right) =>
                left.localeCompare(right),
            ),
        );
        expect(prepared.environment).toMatchObject({
            CAXRI_AGENT_LAUNCHER_RUNTIME: process.execPath,
            CAXRI_AGENT_LAUNCHER_SOCKET: socketPath,
            CAXRI_AGENT_LAUNCHER_ID: 'launch-1',
        });
        await server.cancel('terminal-1', 'launch-1');
        await expect(prepared.started).rejects.toThrow(
            'Managed Agent launch ended before the Agent started',
        );
    });

    it('consumes a valid claim token exactly once', async () => {
        const { directory, server, socketPath } = await createTestServer();
        const prepared = server.prepare({
            terminalId: 'terminal-1',
            launchId: 'launch-1',
            plan: immediateExitPlan(directory),
        });
        const token = prepared.environment.CAXRI_AGENT_LAUNCHER_TOKEN;

        const first = await rawClaim(socketPath, 'launch-1', token);
        expect(JSON.parse(first.response.trim())).toEqual(immediateExitPlan(directory));

        const second = await rawClaim(socketPath, 'launch-1', token);
        expect(second.response).toBe('');

        await Promise.all([first.close(), second.close()]);
    });

    it('expires an unclaimed prepared launch and releases both identities', async () => {
        const { directory, server } = await createTestServer();
        const prepared = server.prepare({
            terminalId: 'terminal-timeout',
            launchId: 'launch-timeout',
            plan: immediateExitPlan(directory),
        });

        await expect(prepared.started).rejects.toThrow(
            'Managed Agent launch ended before the Agent started',
        );

        const replacement = server.prepare({
            terminalId: 'terminal-timeout',
            launchId: 'launch-timeout',
            plan: immediateExitPlan(directory),
        });
        await expect(server.cancel('terminal-timeout', 'launch-timeout')).resolves.toBe(true);
        await expect(replacement.started).rejects.toThrow(
            'Managed Agent launch ended before the Agent started',
        );
    });

    it('expires a claimed launch that never reports started and closes its socket', async () => {
        const { directory, server, socketPath } = await createTestServer();
        const prepared = server.prepare({
            terminalId: 'terminal-timeout',
            launchId: 'launch-timeout',
            plan: immediateExitPlan(directory),
        });
        const claim = await rawClaim(
            socketPath,
            'launch-timeout',
            prepared.environment.CAXRI_AGENT_LAUNCHER_TOKEN,
        );

        await expect(prepared.started).rejects.toThrow(
            'Managed Agent launch ended before the Agent started',
        );
        await vi.waitFor(() =>
            expect(
                (Reflect.get(server, 'sockets') as Set<ReturnType<typeof createConnection>>).size,
            ).toBe(0),
        );

        const replacement = server.prepare({
            terminalId: 'terminal-timeout',
            launchId: 'launch-timeout',
            plan: immediateExitPlan(directory),
        });
        await claim.close();
        await expect(server.cancel('terminal-timeout', 'launch-timeout')).resolves.toBe(true);
        await expect(replacement.started).rejects.toThrow(
            'Managed Agent launch ended before the Agent started',
        );
    });

    it('spawns with structured argv and only the plan cwd/environment, then reports started and exited', async () => {
        const events: ManagedAgentLauncherEvent[] = [];
        const { directory, server, socketPath } = await createTestServer((event) =>
            events.push(event),
        );
        const outputPath = join(directory, 'child-result.json');
        const childSource = [
            "const { writeFileSync } = require('node:fs');",
            'writeFileSync(process.env.OUTPUT_PATH, JSON.stringify({',
            '  argv: process.argv.slice(1),',
            '  cwd: process.cwd(),',
            '  value: process.env.EXPECTED_VALUE,',
            '  path: process.env.PATH,',
            '  launcherToken: process.env.CAXRI_AGENT_LAUNCHER_TOKEN,',
            '}));',
        ].join('\n');
        const prepared = server.prepare({
            terminalId: 'terminal-1',
            launchId: 'launch-1',
            plan: {
                executable: process.execPath,
                args: ['-e', childSource, '--', 'argument with spaces', 'literal;$(echo unsafe)'],
                environment: {
                    OUTPUT_PATH: outputPath,
                    EXPECTED_VALUE: 'plan-only',
                },
                cwd: directory,
            },
        });
        const launcherEnvironment = { ...prepared.environment };

        const completed = runManagedAgentLauncher({
            socketPath,
            launchId: 'launch-1',
            environment: launcherEnvironment,
        });
        expect(launcherEnvironment.CAXRI_AGENT_LAUNCHER_TOKEN).toBeUndefined();

        const processId = await prepared.started;
        expect(processId).toBeGreaterThan(0);
        await expect(completed).resolves.toEqual({ exitCode: 0, signal: null });
        const childResult = JSON.parse(await readFile(outputPath, 'utf8')) as Record<
            string,
            unknown
        >;
        expect(childResult).toEqual({
            argv: ['argument with spaces', 'literal;$(echo unsafe)'],
            cwd: await realpath(directory),
            value: 'plan-only',
        });
        expect(events).toEqual([
            { type: 'started', terminalId: 'terminal-1', launchId: 'launch-1', processId },
            {
                type: 'exited',
                terminalId: 'terminal-1',
                launchId: 'launch-1',
                exitCode: 0,
                signal: null,
            },
        ]);
    });

    it('signals only the exact live terminalId and launchId', async () => {
        const { directory, server, socketPath } = await createTestServer();
        const readyPath = join(directory, 'signal-ready');
        const prepared = server.prepare({
            terminalId: 'terminal-1',
            launchId: 'launch-current',
            plan: {
                executable: process.execPath,
                args: [
                    '-e',
                    "require('node:fs').writeFileSync(process.env.READY_PATH, ''); process.on('SIGINT', () => process.exit(23)); setInterval(() => {}, 1000)",
                ],
                environment: { READY_PATH: readyPath },
                cwd: directory,
            },
        });
        const completed = runManagedAgentLauncher({
            socketPath,
            launchId: 'launch-current',
            environment: { ...prepared.environment },
        });
        const processId = await prepared.started;
        await vi.waitFor(() => access(readyPath));

        expect(server.signalExact('terminal-1', 'launch-stale', 'SIGINT')).toBe(false);
        expect(server.signalExact('terminal-stale', 'launch-current', 'SIGINT')).toBe(false);
        expect(isProcessAlive(processId)).toBe(true);
        expect(server.signalExact('terminal-1', 'launch-current', 'SIGINT')).toBe(true);
        await expect(completed).resolves.toEqual({ exitCode: 23, signal: null });
        await vi.waitFor(() =>
            expect(server.signalExact('terminal-1', 'launch-current', 'SIGINT')).toBe(false),
        );
    });

    it('does not duplicate terminal foreground signals but preserves socket signals and SIGTERM termination', async () => {
        const { directory, server, socketPath } = await createTestServer();
        const prepared = server.prepare({
            terminalId: 'terminal-signals',
            launchId: 'launch-signals',
            plan: immediateExitPlan(directory),
        });
        const originalSigintListeners = new Set(process.listeners('SIGINT'));
        const originalSighupListeners = new Set(process.listeners('SIGHUP'));
        const originalSigtermListeners = new Set(process.listeners('SIGTERM'));
        const kill = vi.fn(() => true);
        const childListeners = new Map<string, (...arguments_: unknown[]) => void>();
        const child = {
            pid: 47_201,
            kill,
            once(event: string, listener: (...arguments_: unknown[]) => void) {
                childListeners.set(event, listener);
                return child;
            },
        } as unknown as ChildProcess;
        const completed = runManagedAgentLauncher({
            socketPath,
            launchId: 'launch-signals',
            environment: { ...prepared.environment },
            spawnChild: () => {
                queueMicrotask(() => childListeners.get('spawn')?.());
                return child;
            },
        });
        await prepared.started;

        const foregroundSigint = process
            .listeners('SIGINT')
            .find((listener) => !originalSigintListeners.has(listener));
        const foregroundSighup = process
            .listeners('SIGHUP')
            .find((listener) => !originalSighupListeners.has(listener));
        const foregroundSigterm = process
            .listeners('SIGTERM')
            .find((listener) => !originalSigtermListeners.has(listener));
        expect(foregroundSigint).toBeDefined();
        expect(foregroundSighup).toBeDefined();
        expect(foregroundSigterm).toBeDefined();

        foregroundSigint?.('SIGINT');
        foregroundSighup?.('SIGHUP');
        expect(kill).not.toHaveBeenCalled();

        expect(server.signalExact('terminal-signals', 'launch-signals', 'SIGINT')).toBe(true);
        await vi.waitFor(() => expect(kill).toHaveBeenCalledWith('SIGINT'));
        expect(server.signalExact('terminal-signals', 'launch-signals', 'SIGHUP')).toBe(true);
        await vi.waitFor(() => expect(kill).toHaveBeenCalledWith('SIGHUP'));

        foregroundSigterm?.('SIGTERM');
        expect(kill).toHaveBeenCalledWith('SIGTERM');
        await vi.waitFor(() => expect(kill).toHaveBeenCalledWith('SIGKILL'), { timeout: 1_100 });
        childListeners.get('exit')?.(0, null);
        await expect(completed).resolves.toEqual({ exitCode: 0, signal: null });
    });

    it('delegates disconnect termination to the launcher without signaling a cached PID', async () => {
        const events: ManagedAgentLauncherEvent[] = [];
        const { directory, server, socketPath } = await createTestServer((event) =>
            events.push(event),
        );
        const prepared = server.prepare({
            terminalId: 'terminal-disconnect-owner',
            launchId: 'launch-disconnect-owner',
            plan: immediateExitPlan(directory),
        });
        const childListeners = new Map<string, (...arguments_: unknown[]) => void>();
        const kill = vi.fn((signal: NodeJS.Signals) => {
            queueMicrotask(() => childListeners.get('exit')?.(null, signal));
            return true;
        });
        const child = {
            pid: 47_202,
            kill,
            once(event: string, listener: (...arguments_: unknown[]) => void) {
                childListeners.set(event, listener);
                return child;
            },
        } as unknown as ChildProcess;
        const completed = runManagedAgentLauncher({
            socketPath,
            launchId: 'launch-disconnect-owner',
            environment: { ...prepared.environment },
            spawnChild: () => {
                queueMicrotask(() => childListeners.get('spawn')?.());
                return child;
            },
        });
        await prepared.started;
        const processKill = vi.spyOn(process, 'kill');
        const sockets = Reflect.get(server, 'sockets') as Set<ReturnType<typeof createConnection>>;

        try {
            for (const socket of sockets) socket.destroy();
            await expect(completed).rejects.toThrow('Managed Agent launcher failed closed');
            await vi.waitFor(() => expect(events).toHaveLength(2));
            expect(kill).toHaveBeenCalledWith('SIGHUP');
            expect(processKill).not.toHaveBeenCalled();
            expect(events.at(-1)).toEqual({
                type: 'exited',
                terminalId: 'terminal-disconnect-owner',
                launchId: 'launch-disconnect-owner',
                exitCode: null,
                signal: 'SIGHUP',
            });
        } finally {
            processKill.mockRestore();
        }
    });

    /**
     * Regression for issue caxri#1345: Host resolves and validates the plan's executable before handing it to the
     * launcher, but the file can still disappear (moved, updated, uninstalled) in the gap before this spawn. Node
     * reports that as an `'error'` event with `code: 'ENOENT'` and no `pid`: the launcher must explain that on stderr
     * before it exits and this PTY silently becomes an ordinary shell.
     */
    it('explains an ENOENT spawn failure on stderr before falling back to a plain shell', async () => {
        const { directory, server, socketPath } = await createTestServer();
        const prepared = server.prepare({
            terminalId: 'terminal-enoent',
            launchId: 'launch-enoent',
            plan: {
                executable: '/opt/removed-cli/claude',
                args: [],
                environment: {},
                cwd: directory,
            },
        });
        const childListeners = new Map<string, (...arguments_: unknown[]) => void>();
        const child = {
            pid: undefined,
            kill: vi.fn(() => true),
            once(event: string, listener: (...arguments_: unknown[]) => void) {
                childListeners.set(event, listener);
                return child;
            },
        } as unknown as ChildProcess;
        const stderrWrite = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
        try {
            const completed = runManagedAgentLauncher({
                socketPath,
                launchId: 'launch-enoent',
                environment: { ...prepared.environment },
                spawnChild: () => {
                    const error = new Error(
                        'spawn /opt/removed-cli/claude ENOENT',
                    ) as NodeJS.ErrnoException;
                    error.code = 'ENOENT';
                    queueMicrotask(() => childListeners.get('error')?.(error));
                    return child;
                },
            });

            await expect(completed).rejects.toThrow('Managed Agent launcher failed closed');
            expect(stderrWrite).toHaveBeenCalledWith(expect.stringContaining('claude') as string);
            expect(stderrWrite).toHaveBeenCalledWith(
                expect.stringContaining('could not be started: it was not found') as string,
            );
        } finally {
            stderrWrite.mockRestore();
        }
    });

    it('leaves no child after cancel or server close', async () => {
        const { directory, server, socketPath } = await createTestServer();
        const first = server.prepare({
            terminalId: 'terminal-1',
            launchId: 'launch-cancel',
            plan: {
                executable: process.execPath,
                args: ['-e', 'setInterval(() => {}, 1000)'],
                environment: {},
                cwd: directory,
            },
        });
        const firstCompleted = runManagedAgentLauncher({
            socketPath,
            launchId: 'launch-cancel',
            environment: { ...first.environment },
        });
        const firstProcessId = await first.started;

        await expect(server.cancel('terminal-1', 'launch-cancel')).resolves.toBe(true);
        await firstCompleted;
        expect(isProcessAlive(firstProcessId)).toBe(false);

        const second = server.prepare({
            terminalId: 'terminal-1',
            launchId: 'launch-close',
            plan: {
                executable: process.execPath,
                args: ['-e', 'setInterval(() => {}, 1000)'],
                environment: {},
                cwd: directory,
            },
        });
        const secondCompleted = runManagedAgentLauncher({
            socketPath,
            launchId: 'launch-close',
            environment: { ...second.environment },
        });
        const secondProcessId = await second.started;

        await server.close();
        await secondCompleted;
        expect(isProcessAlive(secondProcessId)).toBe(false);
    });

    it('kills the Agent when its authenticated launcher connection disconnects', async () => {
        const events: ManagedAgentLauncherEvent[] = [];
        const { directory, server, socketPath } = await createTestServer((event) =>
            events.push(event),
        );
        const prepared = server.prepare({
            terminalId: 'terminal-1',
            launchId: 'launch-disconnect',
            plan: {
                executable: process.execPath,
                args: ['-e', 'setInterval(() => {}, 1000)'],
                environment: {},
                cwd: directory,
            },
        });
        const completed = runManagedAgentLauncher({
            socketPath,
            launchId: 'launch-disconnect',
            environment: { ...prepared.environment },
        });
        const processId = await prepared.started;
        const sockets = Reflect.get(server, 'sockets') as Set<ReturnType<typeof createConnection>>;
        expect(sockets.size).toBe(1);

        for (const socket of sockets) socket.destroy();

        await expect(completed).rejects.toThrow('Managed Agent launcher failed closed');
        await vi.waitFor(() => expect(isProcessAlive(processId)).toBe(false));
        await vi.waitFor(() => expect(events).toHaveLength(2));
        expect(events.at(-1)).toEqual({
            type: 'exited',
            terminalId: 'terminal-1',
            launchId: 'launch-disconnect',
            exitCode: null,
            signal: 'SIGHUP',
        });
    });
});

describe('managed Agent launcher process arguments', () => {
    it('accepts only the exact private mode argument shape', async () => {
        expect(MANAGED_AGENT_LAUNCHER_FLAG).toBe('--managed-agent-launcher');
        expect(
            parseManagedAgentLauncherProcessArguments([
                MANAGED_AGENT_LAUNCHER_FLAG,
                '/tmp/launcher.sock',
                'launch-1',
            ]),
        ).toEqual({ socketPath: '/tmp/launcher.sock', launchId: 'launch-1' });
        expect(
            parseManagedAgentLauncherProcessArguments([
                MANAGED_AGENT_LAUNCHER_FLAG,
                '/tmp/launcher.sock',
                'launch-1',
                'unexpected',
            ]),
        ).toBeUndefined();

        const environment = { CAXRI_AGENT_LAUNCHER_TOKEN: 'one-use-token' };
        await expect(
            runManagedAgentLauncherProcess({ argv: ['invalid'], environment }),
        ).resolves.toBe(1);
        expect(environment.CAXRI_AGENT_LAUNCHER_TOKEN).toBeUndefined();
    });
});

describe('managed Agent launcher socket path', () => {
    it('stays within the macOS Unix socket limit under the real user temp directory', async () => {
        const socketPath = managedAgentLauncherSocketPath(
            tmpdir(),
            '01a050c4-3cb6-7543-8604-1c238994563a',
        );
        const server = new ManagedAgentLauncherServer({
            socketPath,
            runtimePath: process.execPath,
            entryPath: join(tmpdir(), 'agent-launcher.js'),
        });
        servers.push(server);

        expect(Buffer.byteLength(socketPath, 'utf8')).toBeLessThanOrEqual(103);
        expect(socketPath.startsWith(tmpdir())).toBe(true);
        await expect(server.start()).resolves.toBeUndefined();
        expect((await stat(socketPath)).mode & 0o777).toBe(0o600);
    });

    /**
     * The E2E harness gives every Playwright worker its own `caxri-e2e-<pool>-<index>` directory under the per-user
     * temp root, which is exactly the shape that used to exceed `sun_path` and kill Terminal Host at module top level.
     *
     * How much of the budget that shape actually consumes depends on the machine: the macOS per-user temp root is 49
     * bytes, while CI points `TMPDIR` at a deliberately short `/private/tmp` symlink (see
     * `scripts/self-hosted-runner.ts`) where one worker directory still fits. Nesting until the socket provably cannot
     * fit keeps this a test of the fallback everywhere rather than a test of one machine's temp path.
     */
    it('starts from a worker temp directory too deep for the socket limit', async () => {
        const bootId = '4bd5b8e2-8a1b-4b0e-9d95-2c0a2f1b7e64';
        const socketName = basename(managedAgentLauncherSocketPath(tmpdir(), bootId));
        let workerDirectory = join(tmpdir(), 'caxri-e2e-parallel-safe-0');
        while (Buffer.byteLength(join(workerDirectory, socketName), 'utf8') <= 103)
            workerDirectory = join(workerDirectory, 'nested');
        const socketPath = managedAgentLauncherSocketPath(workerDirectory, bootId);
        const server = new ManagedAgentLauncherServer({
            socketPath,
            runtimePath: process.execPath,
            entryPath: join(tmpdir(), 'agent-launcher.js'),
        });
        servers.push(server);

        // Proves the fallback is what keeps this under the limit rather than the directory happening to be short.
        const inWorkerDirectory = join(workerDirectory, basename(socketPath));
        expect(Buffer.byteLength(inWorkerDirectory, 'utf8')).toBeGreaterThan(103);
        expect(Buffer.byteLength(socketPath, 'utf8')).toBeLessThanOrEqual(103);
        await expect(server.start()).resolves.toBeUndefined();
        expect((await stat(socketPath)).mode & 0o777).toBe(0o600);
    });

    it('keeps every supported directory depth within the limit', () => {
        for (const depth of [0, 1, 2, 4, 8, 16]) {
            const directory = join(tmpdir(), ...Array.from({ length: depth }, () => 'nested-name'));
            const socketPath = managedAgentLauncherSocketPath(
                directory,
                '0f2b9c71-5f3f-4c41-b0a7-19f0c5a0e1d2',
            );
            expect(Buffer.byteLength(socketPath, 'utf8')).toBeLessThanOrEqual(103);
        }
    });

    it('rejects a relative directory', () => {
        expect(() =>
            managedAgentLauncherSocketPath('relative', '0f2b9c71-5f3f-4c41-b0a7-19f0c5a0e1d2'),
        ).toThrow('must be absolute');
    });
});
