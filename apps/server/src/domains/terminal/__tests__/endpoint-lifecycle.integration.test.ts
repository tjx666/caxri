import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ServerEvent } from '@caxri/protocol';
import { defaultAgentActionsSettings, defaultAgentOutputRecoverySettings } from '@caxri/protocol';
import { StructuredLogger } from '@caxri/system';
import type { IPty, spawn as spawnPty } from 'node-pty';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createTestTerminalManager } from '../../../__tests__/support/terminal';
import { AgentEndpointLifecycle } from '../../agent-endpoints';
import { AgentMessagingCapabilityProbe } from '../../agent-messaging';
import { CaxriDatabase } from '../../db/repository';

const temporaryDirectories: string[] = [];

function createFakePty() {
    let onData: ((data: string) => void) | undefined;
    let onExit: ((event: { exitCode: number; signal?: number }) => void) | undefined;
    const kill = vi.fn();
    const process = {
        cols: 100,
        kill,
        onData: vi.fn((listener: (data: string) => void) => {
            onData = listener;
            return { dispose: vi.fn() };
        }),
        onExit: vi.fn((listener: (event: { exitCode: number; signal?: number }) => void) => {
            onExit = listener;
            return { dispose: vi.fn() };
        }),
        resize: vi.fn(),
        rows: 30,
        write: vi.fn(),
    } as unknown as IPty;
    return {
        emitData: (data: string) => onData?.(data),
        emitExit: (event: { exitCode: number; signal?: number }) => onExit?.(event),
        kill,
        process,
    };
}

afterEach(async () => {
    const directoriesToRemove = [...temporaryDirectories];
    temporaryDirectories.length = 0;
    await Promise.all(
        directoriesToRemove.map((path) => rm(path, { recursive: true, force: true })),
    );
});

describe('TerminalManager Agent Endpoint lifecycle', () => {
    it('spawns an Agent PTY before a slow messaging capability probe settles', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-pty-endpoint-probe-'));
        temporaryDirectories.push(directory);
        const database = new CaxriDatabase(join(directory, 'state.db'));
        const created = database.createSession(database.createProject(directory).id, 'codex');
        const probeResult = Promise.withResolvers<{ executable: string; version: string }>();
        const providerProbe = vi.fn(() => probeResult.promise);
        const messaging = vi.fn(() => Promise.resolve(true));
        const endpoints = new AgentEndpointLifecycle(
            {
                activate: () => Promise.resolve(true),
                begin: () =>
                    Promise.resolve({
                        ref: { hostId: 'host-1', endpointId: 'endpoint-1', generation: 1 },
                        token: 'ab'.repeat(32),
                        expiresAt: 10_000,
                    }),
                messaging,
                retire: () => Promise.resolve(true),
            },
            directory,
            new AgentMessagingCapabilityProbe({
                cliAvailable: () => Promise.resolve(true),
                cliPath: '/caxri',
                fixtureMode: false,
                probe: providerProbe,
            }),
        );
        const fake = createFakePty();
        const spawn = vi.fn<typeof spawnPty>(() => fake.process);
        const manager = createTestTerminalManager(
            database,
            () => {},
            new StructuredLogger(join(directory, 'logs')),
            {
                agentEnvironment: () => Promise.resolve({ PATH: '/usr/bin' }),
                agentLaunchSettings: () => ({ executable: 'codex', args: [] }),
                lifecycleEnvironment: (record) =>
                    endpoints.environment(record, created.session.projectId, {
                        actions: structuredClone(defaultAgentActionsSettings),
                        hooks: { enabled: false },
                        launch: { executable: 'codex', args: [] },
                        messaging: { enabled: true },
                        pasteSummary: { enabled: true },
                        recovery: defaultAgentOutputRecoverySettings,
                    }),
                onLifecycleStarted: (record) => endpoints.activate(record.id),
                onLifecycleRetired: (terminalId) => endpoints.retire(terminalId),
                resolveExecutable: () => Promise.resolve('/bin/codex'),
                spawn,
            },
        );

        try {
            await expect(manager.start(created.terminal!)).resolves.toMatchObject({
                id: created.terminal!.id,
                lastProcessState: 'running',
            });
            expect(spawn).toHaveBeenCalledOnce();
            await vi.waitFor(() => expect(providerProbe).toHaveBeenCalledOnce());
            expect(messaging).not.toHaveBeenCalled();

            probeResult.resolve({ executable: '/bin/codex', version: 'codex-cli 0.147.0' });
            await vi.waitFor(() => expect(messaging).toHaveBeenCalledOnce());
        } finally {
            probeResult.resolve({ executable: '/bin/codex', version: 'codex-cli 0.147.0' });
            fake.kill();
            manager.close(created.terminal!.id);
            database.close();
        }
    });

    it('captures PTY output and exit before a slow Endpoint activation settles', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-pty-endpoint-activation-'));
        temporaryDirectories.push(directory);
        const database = new CaxriDatabase(join(directory, 'state.db'));
        const created = database.createSession(database.createProject(directory).id, 'codex');
        const activation = Promise.withResolvers<void>();
        const onLifecycleStarted = vi.fn(() => activation.promise);
        const fake = createFakePty();
        const emitted: ServerEvent[] = [];
        const manager = createTestTerminalManager(
            database,
            (event) => {
                emitted.push(event);
            },
            new StructuredLogger(join(directory, 'logs')),
            {
                agentEnvironment: () => Promise.resolve({ PATH: '/usr/bin' }),
                agentLaunchSettings: () => ({ executable: 'codex', args: [] }),
                lifecycleEnvironment: () => ({ CAXRI_AGENT_TEST: '1' }),
                onLifecycleStarted,
                resolveExecutable: (kind) =>
                    Promise.resolve(kind === 'shell' ? '/bin/zsh' : '/bin/codex'),
                spawn: () => fake.process,
            },
        );

        const starting = manager.start(created.terminal!);
        try {
            await vi.waitFor(() => expect(onLifecycleStarted).toHaveBeenCalledOnce());
            expect(fake.process.onData).toHaveBeenCalledOnce();
            expect(fake.process.onExit).toHaveBeenCalledOnce();

            fake.emitData('ready before activation');
            fake.emitExit({ exitCode: 0 });
            await vi.waitFor(() =>
                expect(database.getTerminal(created.terminal!.id)?.lastProcessState).toBe(
                    'stopped',
                ),
            );
            expect(database.getSnapshot(created.terminal!.id)?.payload).toContain(
                'ready before activation',
            );
            expect(
                emitted.some(
                    (event) =>
                        event.event === 'terminal.exit' &&
                        event.payload.terminalId === created.terminal!.id,
                ),
            ).toBe(true);

            activation.resolve();
            await expect(starting).resolves.toMatchObject({ lastProcessState: 'running' });
        } finally {
            activation.resolve();
            manager.close(created.terminal!.id);
            database.close();
        }
    });

    it('awaits prepared Endpoint retirement when PTY spawn fails', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-pty-endpoint-failure-'));
        temporaryDirectories.push(directory);
        const database = new CaxriDatabase(join(directory, 'state.db'));
        const created = database.createSession(database.createProject(directory).id, 'codex');
        const retirement = Promise.withResolvers<boolean>();
        const retire = vi.fn(() => retirement.promise);
        const endpoints = new AgentEndpointLifecycle(
            {
                activate: () => Promise.resolve(true),
                begin: () =>
                    Promise.resolve({
                        ref: { hostId: 'host-1', endpointId: 'endpoint-1', generation: 1 },
                        token: 'ab'.repeat(32),
                        expiresAt: 10_000,
                    }),
                messaging: () => Promise.resolve(true),
                retire,
            },
            directory,
        );
        const manager = createTestTerminalManager(
            database,
            () => {},
            new StructuredLogger(join(directory, 'logs')),
            {
                agentEnvironment: () => Promise.resolve({ PATH: '/usr/bin' }),
                agentLaunchSettings: () => ({ executable: 'codex', args: [] }),
                lifecycleEnvironment: (record) =>
                    endpoints.environment(record, created.session.projectId, {
                        actions: structuredClone(defaultAgentActionsSettings),
                        hooks: { enabled: false },
                        launch: { executable: 'codex', args: [] },
                        messaging: { enabled: true },
                        pasteSummary: { enabled: true },
                        recovery: defaultAgentOutputRecoverySettings,
                    }),
                onLifecycleRetired: (terminalId) => endpoints.retire(terminalId),
                resolveExecutable: () => Promise.resolve('/bin/codex'),
                spawn: () => {
                    throw new Error('spawn failure');
                },
            },
        );

        const starting = manager.start(created.terminal!);
        await vi.waitFor(() => expect(retire).toHaveBeenCalledOnce());
        expect(endpoints.endpointForTerminal(created.terminal!.id)).toBeUndefined();
        let isSettled = false;
        // Intentionally not awaited: the test must observe `isSettled` before `starting` settles,
        // so this attaches an observer instead of blocking on the promise.
        /* eslint-disable unicorn/prefer-await */
        starting
            .then(() => {
                isSettled = true;
            })
            .catch(() => {
                isSettled = true;
            });
        /* eslint-enable unicorn/prefer-await */
        await Promise.resolve();
        expect(isSettled).toBe(false);
        retirement.resolve(true);

        try {
            await expect(starting).rejects.toThrow('spawn failure');
            expect(database.getTerminal(created.terminal!.id)?.lastProcessState).toBe('failed');
        } finally {
            manager.close(created.terminal!.id);
            database.close();
        }
    });
});
