import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { AgentLaunchSettings, ServerEvent, TerminalKind } from '@caxri/protocol';
import { StructuredLogger } from '@caxri/system';
import type { IPty, spawn as spawnPty } from 'node-pty';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { LocalTerminalExecution } from '../../../__tests__/support/local-terminal-execution';
import { createTestTerminalManager } from '../../../__tests__/support/terminal';
import { TERMINAL_IMAGE_RECOVERY_PLACEHOLDER } from '../../../terminal-host/engine/image-recovery';
import { CaxriDatabase } from '../../db/repository';

const temporaryDirectories: string[] = [];
const temporaryLoggers: StructuredLogger[] = [];

/**
 * Tracks buffered loggers so teardown flushes async appends before removing each temporary profile.
 */
function createTestLogger(logDirectory: string): StructuredLogger {
    const logger = new StructuredLogger(logDirectory);
    temporaryLoggers.push(logger);
    return logger;
}

function createFakePty() {
    let onData: ((data: string) => void) | undefined;
    let onExit: ((event: { exitCode: number; signal?: number }) => void) | undefined;
    let cols = 100;
    let rows = 30;
    const kill = vi.fn();
    const resize = vi.fn((nextCols: number, nextRows: number) => {
        cols = nextCols;
        rows = nextRows;
    });
    const write = vi.fn();
    const process = {
        get cols() {
            return cols;
        },
        kill,
        pid: 7_777,
        onData: vi.fn((listener: (data: string) => void) => {
            onData = listener;
            return { dispose: vi.fn() };
        }),
        onExit: vi.fn((listener: (event: { exitCode: number; signal?: number }) => void) => {
            onExit = listener;
            return { dispose: vi.fn() };
        }),
        resize,
        get rows() {
            return rows;
        },
        write,
    } as unknown as IPty;
    return {
        emitData: (data: string) => onData?.(data),
        emitExit: (event: { exitCode: number; signal?: number }) => onExit?.(event),
        kill,
        process,
        resize,
        write,
    };
}

afterEach(async () => {
    vi.unstubAllEnvs();
    const pendingLoggers = [...temporaryLoggers];
    temporaryLoggers.length = 0;
    await Promise.all(pendingLoggers.map((logger) => logger.flush()));
    const pendingCleanup = [...temporaryDirectories];
    temporaryDirectories.length = 0;
    await Promise.all(pendingCleanup.map((path) => rm(path, { recursive: true, force: true })));
});

describe('TerminalManager', () => {
    it('persists a provider-specific missing CLI detail for the recovery row', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-pty-missing-agent-cli-'));
        temporaryDirectories.push(directory);
        const database = new CaxriDatabase(join(directory, 'state.db'));
        const created = database.createSession(database.createProject(directory).id, 'claude');
        const manager = createTestTerminalManager(
            database,
            () => {},
            createTestLogger(join(directory, 'logs')),
            {
                resolveExecutable: (kind) =>
                    kind === 'shell'
                        ? Promise.resolve('/bin/zsh')
                        : Promise.reject(new Error('private executable path')),
            },
        );

        try {
            await expect(manager.start(created.terminal!)).rejects.toThrow(
                'private executable path',
            );
            expect(database.getTerminal(created.terminal!.id)).toMatchObject({
                lastProcessState: 'failed',
                failureReason: 'executable_not_found',
                failureDetail: 'Claude CLI was not found',
            });
        } finally {
            manager.close(created.terminal!.id);
            database.close();
        }
    });

    it('isolates Agent lifecycle environment and fences an intentional restart', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-pty-lifecycle-'));
        temporaryDirectories.push(directory);
        const database = new CaxriDatabase(join(directory, 'state.db'));
        const created = database.createSession(database.createProject(directory).id, 'codex');
        const spawned: Array<ReturnType<typeof createFakePty>> = [];
        const spawn = vi.fn<typeof spawnPty>(() => {
            const fake = createFakePty();
            spawned.push(fake);
            return fake.process;
        });
        let generation = 0;
        const lifecycleEnvironment = vi.fn(() => ({
            CAXRI_HOOK_LAUNCH_ID: `launch-${(generation += 1)}`,
            CAXRI_HOOK_TOKEN: `token-${generation}`,
        }));
        const logger = createTestLogger(join(directory, 'logs'));
        const execution = new LocalTerminalExecution({ logger, spawn });
        const agentStates: string[] = [];
        const interruptionCauses: Array<string | undefined> = [];
        const retired = vi.fn();
        const manager = createTestTerminalManager(database, () => {}, logger, {
            agentEnvironment: () => Promise.resolve({ PATH: '/agent/bin' }),
            agentLaunchSettings: () => ({ executable: 'codex', args: [] }),
            execution,
            lifecycleEnvironment,
            onAgentStateChanged: (_terminalId, state, cause) => {
                agentStates.push(state);
                if (state === 'interrupted') interruptionCauses.push(cause);
            },
            onLifecycleRetired: retired,
            resolveExecutable: (kind) =>
                Promise.resolve(kind === 'shell' ? '/bin/zsh' : '/bin/codex'),
        });

        try {
            await manager.start(created.terminal!);
            await manager.waitForAgentRunning(created.terminal!.id);
            expect(spawn.mock.calls[0]?.[0]).toBe('/bin/zsh');
            expect(spawn.mock.calls[0]?.[2].env).not.toHaveProperty('CAXRI_HOOK_TOKEN');
            expect(lifecycleEnvironment).toHaveBeenCalledOnce();

            agentStates.length = 0;
            const restartBarrier = execution.restartBarrier.bind(execution);
            vi.spyOn(execution, 'restartBarrier').mockImplementation((terminalId) => {
                expect(execution.emitAgentExit(terminalId, null, 'SIGHUP')).toBe(true);
                return restartBarrier(terminalId);
            });
            await manager.restart(created.terminal!.id);
            await manager.waitForAgentRunning(created.terminal!.id);
            expect(retired).toHaveBeenCalledWith(created.terminal!.id, expect.any(String));
            expect(spawn.mock.calls[1]?.[2].env).not.toHaveProperty('CAXRI_HOOK_TOKEN');
            expect(lifecycleEnvironment).toHaveBeenCalledTimes(2);
            expect(agentStates.filter((state) => state !== 'running')).toEqual(['interrupted']);
            expect(agentStates).not.toContain('dead');
            expect(interruptionCauses).toEqual(['terminalRestart']);
        } finally {
            manager.close(created.terminal!.id);
            database.close();
        }
    });

    it('keeps the filtered Agent environment out of the parent Shell across resume', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-pty-agent-launch-'));
        temporaryDirectories.push(directory);
        const database = new CaxriDatabase(join(directory, 'state.db'));
        const created = database.createSession(database.createProject(directory).id, 'codex');
        const spawned: Array<ReturnType<typeof createFakePty>> = [];
        const spawn = vi.fn<typeof spawnPty>(() => {
            const fake = createFakePty();
            spawned.push(fake);
            return fake.process;
        });
        const agentEnvironment = vi.fn(() =>
            Promise.resolve({ HOME: directory, PATH: '/login/bin:/usr/bin' }),
        );
        const manager = createTestTerminalManager(
            database,
            () => {},
            createTestLogger(join(directory, 'logs')),
            {
                agentLaunchSettings: () => ({
                    executable: '/bin/echo',
                    args: ['--profile', 'focused'],
                }),
                agentEnvironment,
                resolveExecutable: (kind) =>
                    Promise.resolve(kind === 'shell' ? '/bin/zsh' : '/bin/echo'),
                spawn,
            },
        );

        try {
            await manager.start(created.terminal!);
            await manager.waitForAgentRunning(created.terminal!.id);
            expect(spawn.mock.calls[0]?.[0]).toBe('/bin/zsh');
            expect(spawn.mock.calls[0]?.[1]).toEqual(['-l']);
            expect(spawn.mock.calls[0]?.[2].env).not.toMatchObject({
                PATH: '/login/bin:/usr/bin',
            });

            await manager.restart(created.terminal!.id, {
                resumeAgentSessionId: 'conversation-1',
            });
            await manager.waitForAgentRunning(created.terminal!.id);
            expect(spawn).toHaveBeenNthCalledWith(2, '/bin/zsh', ['-l'], expect.any(Object));
            expect(agentEnvironment).toHaveBeenCalledTimes(2);
        } finally {
            for (const fake of spawned) fake.kill();
            manager.close(created.terminal!.id);
            database.close();
        }
    });

    it('keeps the same Shell running when its managed Agent exits', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-agent-exit-shell-'));
        temporaryDirectories.push(directory);
        const database = new CaxriDatabase(join(directory, 'state.db'));
        const created = database.createSession(database.createProject(directory).id, 'codex');
        const fake = createFakePty();
        const events: ServerEvent[] = [];
        const logger = createTestLogger(join(directory, 'logs'));
        const execution = new LocalTerminalExecution({ logger, spawn: () => fake.process });
        const retired = vi.fn();
        const manager = createTestTerminalManager(database, (event) => events.push(event), logger, {
            agentEnvironment: () => Promise.resolve({ PATH: '/agent/bin' }),
            agentLaunchSettings: () => ({ executable: 'codex', args: [] }),
            execution,
            lifecycleEnvironment: () => ({ CAXRI_AGENT_TEST: '1' }),
            onLifecycleRetired: retired,
            resolveExecutable: (kind) =>
                Promise.resolve(kind === 'shell' ? '/bin/zsh' : '/bin/codex'),
        });

        try {
            await manager.start(created.terminal!);
            await manager.waitForAgentRunning(created.terminal!.id);
            const shellProcessId = manager.processId(created.terminal!.id);

            expect(execution.emitAgentExit(created.terminal!.id, 0)).toBe(true);
            await vi.waitFor(() =>
                expect(database.getTerminal(created.terminal!.id)).toMatchObject({
                    lastProcessState: 'running',
                    lastAgentProcessState: 'stopped',
                }),
            );

            expect(manager.processId(created.terminal!.id)).toBe(shellProcessId);
            expect(manager.write(created.terminal!.id, "printf 'RETURNED_TO_SHELL\\n'\r")).toBe(
                true,
            );
            expect(fake.write).toHaveBeenCalledWith("printf 'RETURNED_TO_SHELL\\n'\r");
            expect(events).not.toContainEqual(expect.objectContaining({ event: 'terminal.exit' }));
            await vi.waitFor(() =>
                expect(retired).toHaveBeenCalledWith(created.terminal!.id, expect.any(String)),
            );
        } finally {
            manager.close(created.terminal!.id);
            database.close();
        }
    });

    it('rejects a persisted Agent resume before spawning in real E2E mode', async () => {
        vi.stubEnv('CAXRI_E2E', '1');
        vi.stubEnv('CAXRI_E2E_AGENT_MODE', 'real');
        vi.stubEnv('CAXRI_E2E_AGENT_PROVIDER', 'codex');
        const directory = await mkdtemp(join(tmpdir(), 'caxri-pty-real-agent-resume-'));
        temporaryDirectories.push(directory);
        const database = new CaxriDatabase(join(directory, 'state.db'));
        const created = database.createSession(database.createProject(directory).id, 'codex');
        const spawn = vi.fn<typeof spawnPty>(() => createFakePty().process);
        const manager = createTestTerminalManager(
            database,
            () => {},
            createTestLogger(join(directory, 'logs')),
            {
                agentLaunchSettings: () => ({
                    executable: 'codex',
                    args: [
                        'exec',
                        '--sandbox',
                        'read-only',
                        '--skip-git-repo-check',
                        '--ephemeral',
                        '--ignore-rules',
                        '--color',
                        'never',
                        'Read README.md and report its heading. Do not modify files.',
                    ],
                }),
                agentEnvironment: () => Promise.resolve({ PATH: '/usr/bin' }),
                resolveExecutable: () => Promise.resolve('/usr/bin/codex'),
                spawn,
            },
        );

        try {
            await expect(
                manager.start(created.terminal!, { resumeAgentSessionId: 'persisted-session' }),
            ).rejects.toThrow('does not resume persisted Agent sessions');
            expect(spawn).not.toHaveBeenCalled();
        } finally {
            manager.close(created.terminal!.id);
            database.close();
        }
    });

    it('uses one Agent launch settings snapshot while executable resolution is pending', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-pty-agent-settings-race-'));
        temporaryDirectories.push(directory);
        const database = new CaxriDatabase(join(directory, 'state.db'));
        const created = database.createSession(database.createProject(directory).id, 'codex');
        const fake = createFakePty();
        const spawn = vi.fn<typeof spawnPty>(() => fake.process);
        let launch = { executable: '/old/codex', args: ['--old-profile'] };
        const { promise: resolutionPending, resolve: finishResolution } =
            Promise.withResolvers<void>();
        const resolveExecutable = vi.fn(
            async (_kind: TerminalKind, settings?: AgentLaunchSettings) => {
                if (_kind === 'shell') return '/bin/zsh';
                await resolutionPending;
                if (!settings) throw new Error('Agent launch settings are required');
                return settings.executable;
            },
        );
        const manager = createTestTerminalManager(
            database,
            () => {},
            createTestLogger(join(directory, 'logs')),
            {
                agentEnvironment: () => Promise.resolve({ PATH: '/usr/bin' }),
                agentLaunchSettings: () => launch,
                resolveExecutable,
                spawn,
            },
        );

        try {
            const starting = manager.start(created.terminal!);
            await vi.waitFor(() => expect(resolveExecutable).toHaveBeenCalledTimes(2));
            launch = { executable: '/new/codex', args: ['--new-profile'] };
            finishResolution();
            await starting;

            expect(resolveExecutable).toHaveBeenNthCalledWith(2, 'codex', {
                executable: '/old/codex',
                args: ['--old-profile'],
            });
            expect(spawn).toHaveBeenCalledWith('/bin/zsh', ['-l'], expect.any(Object));
        } finally {
            fake.kill();
            manager.close(created.terminal!.id);
            database.close();
        }
    });

    it('contains an immediately failing Agent Terminal Shell to its durable Terminal', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-pty-agent-fast-failure-'));
        temporaryDirectories.push(directory);
        const database = new CaxriDatabase(join(directory, 'state.db'));
        const created = database.createSession(database.createProject(directory).id, 'codex');
        const createdActivityAt = created.session.lastSessionActivityAt;
        const failed = createFakePty();
        const events: ServerEvent[] = [];
        const manager = createTestTerminalManager(
            database,
            (event) => events.push(event),
            createTestLogger(join(directory, 'logs')),
            {
                resolveExecutable: (kind) =>
                    Promise.resolve(kind === 'shell' ? '/bin/zsh' : '/bin/echo'),
                spawn: () => failed.process,
            },
        );

        await manager.start(created.terminal!);
        failed.emitExit({ exitCode: 127 });

        await vi.waitFor(() =>
            expect(database.getTerminal(created.terminal!.id)?.lastProcessState).toBe('dead'),
        );
        expect(database.getSession(created.session.id)).toMatchObject({
            lastActivityState: 'failed',
            lastSessionActivityReason: 'agent_failed',
        });
        expect(database.getSession(created.session.id)!.lastSessionActivityAt).toBeGreaterThan(
            createdActivityAt,
        );
        expect(events).toContainEqual({
            event: 'state.changed',
            payload: {
                kind: 'records',
                sessionIds: [created.session.id],
                terminalIds: [created.terminal!.id],
            },
        });
        expect(manager.runningCount()).toBe(0);
        expect(database.listProjects()).toHaveLength(1);
        database.close();
    });

    it('renders image bytes live but persists only a content-free recovery placeholder', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-pty-image-recovery-'));
        temporaryDirectories.push(directory);
        const database = new CaxriDatabase(join(directory, 'state.db'));
        const created = database.createSession(database.createProject(directory).id, 'shell');
        const fake = createFakePty();
        let output = '';
        const manager = createTestTerminalManager(
            database,
            (event) => {
                if (event.event === 'terminal.output') output += event.payload.data;
            },
            createTestLogger(join(directory, 'logs')),
            {
                resolveExecutable: () => Promise.resolve('/bin/zsh'),
                spawn: () => fake.process,
            },
        );

        try {
            await manager.start(created.terminal!);
            await manager.attach(created.terminal!.id);
            const image = '\u{1B}]1337;File=inline=1:PNG_SECRET\u{7}';
            fake.emitData(`before${image}after`);
            fake.emitExit({ exitCode: 0 });
            await vi.waitFor(() =>
                expect(database.getSnapshot(created.terminal!.id)?.encodingVersion).toBe(3),
            );

            expect(output).toContain(image);
            expect(database.getSnapshot(created.terminal!.id)?.payload).toBe(
                `before${TERMINAL_IMAGE_RECOVERY_PLACEHOLDER}after`,
            );
            expect(database.getSnapshot(created.terminal!.id)?.payload).not.toContain('PNG_SECRET');
        } finally {
            manager.close(created.terminal!.id);
            database.close();
        }
    });

    it('abandons a stale restore after executable discovery and before PTY spawn', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-pty-stale-restore-'));
        temporaryDirectories.push(directory);
        const database = new CaxriDatabase(join(directory, 'state.db'));
        const created = database.createSession(database.createProject(directory).id, 'shell');
        const executable = Promise.withResolvers<string>();
        const spawn = vi.fn(() => createFakePty().process);
        const manager = createTestTerminalManager(
            database,
            () => {},
            createTestLogger(join(directory, 'logs')),
            { resolveExecutable: () => executable.promise, spawn },
        );
        let isCurrent = true;

        const starting = manager.start(created.terminal!, { shouldStart: () => isCurrent });
        isCurrent = false;
        executable.resolve('/bin/zsh');

        try {
            await expect(starting).resolves.toMatchObject({ lastProcessState: 'interrupted' });
            expect(spawn).not.toHaveBeenCalled();
            expect(manager.runningCount()).toBe(0);
        } finally {
            manager.close(created.terminal!.id);
            database.close();
        }
    });

    it('does not replay queued live output after returning it in an attachment snapshot', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-pty-attach-replay-'));
        temporaryDirectories.push(directory);
        const database = new CaxriDatabase(join(directory, 'state.db'));
        const created = database.createSession(database.createProject(directory).id, 'shell');
        const fake = createFakePty();
        let output = '';
        const logger = createTestLogger(join(directory, 'logs'));
        const write = vi.spyOn(logger, 'write');
        const manager = createTestTerminalManager(
            database,
            (event) => {
                if (event.event === 'terminal.output') output += event.payload.data;
            },
            logger,
            { resolveExecutable: () => Promise.resolve('/bin/zsh'), spawn: () => fake.process },
        );

        await manager.start(created.terminal!);
        await manager.attach(created.terminal!.id);
        fake.emitData('queued exactly once');
        expect((await manager.attach(created.terminal!.id))?.payload).toContain(
            'queued exactly once',
        );
        await new Promise((resolve) => setTimeout(resolve, 30));

        try {
            expect(output).toBe('');
            const attachLogs = write.mock.calls.filter((call) => call[1] === 'pty.attach');
            expect(attachLogs.map((call) => call[2])).toMatchObject([
                { fields: { source: 'live', wasAttached: false } },
                { fields: { source: 'live', wasAttached: true } },
            ]);
            expect(JSON.stringify(attachLogs)).not.toContain('queued exactly once');
        } finally {
            manager.close(created.terminal!.id);
            database.close();
        }
    });

    it('does not resize a live PTY when its grid dimensions are unchanged', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-pty-resize-dedup-'));
        temporaryDirectories.push(directory);
        const database = new CaxriDatabase(join(directory, 'state.db'));
        const created = database.createSession(database.createProject(directory).id, 'shell');
        const fake = createFakePty();
        const manager = createTestTerminalManager(
            database,
            () => {},
            createTestLogger(join(directory, 'logs')),
            { resolveExecutable: () => Promise.resolve('/bin/zsh'), spawn: () => fake.process },
        );

        try {
            await manager.start(created.terminal!);
            expect(manager.resize(created.terminal!.id, 100, 30)).toBe(true);
            expect(fake.resize).not.toHaveBeenCalled();

            expect(manager.resize(created.terminal!.id, 120, 40)).toBe(true);
            expect(manager.resize(created.terminal!.id, 120, 40)).toBe(true);
            expect(fake.resize).toHaveBeenCalledOnce();
            expect(fake.resize).toHaveBeenCalledWith(120, 40);
        } finally {
            manager.close(created.terminal!.id);
            database.close();
        }
    });

    it('resizes the Runtime screen to the Renderer grid before serializing an attachment', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-pty-attach-size-'));
        temporaryDirectories.push(directory);
        const database = new CaxriDatabase(join(directory, 'state.db'));
        const created = database.createSession(database.createProject(directory).id, 'shell');
        const fake = createFakePty();
        const manager = createTestTerminalManager(
            database,
            () => {},
            createTestLogger(join(directory, 'logs')),
            { resolveExecutable: () => Promise.resolve('/bin/zsh'), spawn: () => fake.process },
        );

        try {
            await manager.start(created.terminal!);
            await manager.attach(created.terminal!.id, { cols: 80, rows: 24 });

            expect(fake.resize).toHaveBeenCalledOnce();
            expect(fake.resize).toHaveBeenCalledWith(80, 24);
        } finally {
            manager.close(created.terminal!.id);
            database.close();
        }
    });

    it('starts an attached interrupted Terminal at the Renderer grid instead of the fallback grid', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-pty-restore-size-'));
        temporaryDirectories.push(directory);
        const database = new CaxriDatabase(join(directory, 'state.db'));
        const created = database.createSession(database.createProject(directory).id, 'shell');
        const fake = createFakePty();
        const spawn = vi.fn<typeof spawnPty>(() => fake.process);
        const manager = createTestTerminalManager(
            database,
            () => {},
            createTestLogger(join(directory, 'logs')),
            { resolveExecutable: () => Promise.resolve('/bin/zsh'), spawn },
        );

        try {
            await manager.attach(created.terminal!.id, { cols: 132, rows: 41 });
            await manager.start(created.terminal!);

            expect(spawn.mock.calls[0]?.[2]).toMatchObject({ cols: 132, rows: 41 });
        } finally {
            manager.close(created.terminal!.id);
            database.close();
        }
    });

    it('waits for the receiving Renderer grid before spawning a visible restored Terminal', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-pty-restore-grid-wait-'));
        temporaryDirectories.push(directory);
        const database = new CaxriDatabase(join(directory, 'state.db'));
        const created = database.createSession(database.createProject(directory).id, 'shell');
        const fake = createFakePty();
        const spawn = vi.fn<typeof spawnPty>(() => fake.process);
        const manager = createTestTerminalManager(
            database,
            () => {},
            createTestLogger(join(directory, 'logs')),
            { resolveExecutable: () => Promise.resolve('/bin/zsh'), spawn },
        );

        try {
            const starting = manager.start(created.terminal!, { waitForAttachedSizeMs: 1_000 });
            await new Promise((resolve) => setTimeout(resolve, 0));
            expect(spawn).not.toHaveBeenCalled();

            await manager.attach(created.terminal!.id, { cols: 132, rows: 41 });
            await starting;

            expect(spawn.mock.calls[0]?.[2]).toMatchObject({ cols: 132, rows: 41 });
        } finally {
            manager.close(created.terminal!.id);
            database.close();
        }
    });

    it('cancels a pending restore grid wait during Runtime shutdown', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-pty-restore-grid-shutdown-'));
        temporaryDirectories.push(directory);
        const database = new CaxriDatabase(join(directory, 'state.db'));
        const created = database.createSession(database.createProject(directory).id, 'shell');
        const spawn = vi.fn<typeof spawnPty>(() => createFakePty().process);
        const manager = createTestTerminalManager(
            database,
            () => {},
            createTestLogger(join(directory, 'logs')),
            { resolveExecutable: () => Promise.resolve('/bin/zsh'), spawn },
        );
        let shouldStart = true;
        const starting = manager.start(created.terminal!, {
            shouldStart: () => shouldStart,
            waitForAttachedSizeMs: 100,
        });

        try {
            await new Promise((resolve) => setTimeout(resolve, 0));
            shouldStart = false;
            await manager.shutdown('orderly');

            const isCompletedBeforeTimeout = await Promise.race([
                (async () => {
                    await starting;
                    return true;
                })(),
                new Promise<false>((resolve) => setTimeout(() => resolve(false), 20)),
            ]);
            expect(isCompletedBeforeTimeout).toBe(true);
            expect(spawn).not.toHaveBeenCalled();
            expect(database.getTerminal(created.terminal!.id)).toMatchObject({
                lastProcessState: 'interrupted',
                failureReason: undefined,
            });
        } finally {
            shouldStart = false;
            await starting;
            database.close();
        }
    });

    it('cancels a pending restore grid wait when its restore generation becomes stale', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-pty-restore-grid-cancel-'));
        temporaryDirectories.push(directory);
        const database = new CaxriDatabase(join(directory, 'state.db'));
        const created = database.createSession(database.createProject(directory).id, 'shell');
        const spawn = vi.fn<typeof spawnPty>(() => createFakePty().process);
        const manager = createTestTerminalManager(
            database,
            () => {},
            createTestLogger(join(directory, 'logs')),
            { resolveExecutable: () => Promise.resolve('/bin/zsh'), spawn },
        );
        const cancellation = new AbortController();
        const starting = manager.start(created.terminal!, {
            abortSignal: cancellation.signal,
            shouldStart: () => !cancellation.signal.aborted,
            waitForAttachedSizeMs: 100,
        });

        try {
            await new Promise((resolve) => setTimeout(resolve, 0));
            cancellation.abort();

            const isCompletedBeforeTimeout = await Promise.race([
                (async () => {
                    await starting;
                    return true;
                })(),
                new Promise<false>((resolve) => setTimeout(() => resolve(false), 20)),
            ]);
            expect(isCompletedBeforeTimeout).toBe(true);
            expect(spawn).not.toHaveBeenCalled();
            expect(database.getTerminal(created.terminal!.id)).toMatchObject({
                lastProcessState: 'interrupted',
                failureReason: undefined,
            });
        } finally {
            cancellation.abort();
            await starting;
            database.close();
        }
    });

    it('detaches every Renderer view without stopping its PTY', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-pty-detach-all-'));
        temporaryDirectories.push(directory);
        const database = new CaxriDatabase(join(directory, 'state.db'));
        const created = database.createSession(database.createProject(directory).id, 'shell');
        const fake = createFakePty();
        let output = '';
        const manager = createTestTerminalManager(
            database,
            (event) => {
                if (event.event === 'terminal.output') output += event.payload.data;
            },
            createTestLogger(join(directory, 'logs')),
            { resolveExecutable: () => Promise.resolve('/bin/zsh'), spawn: () => fake.process },
        );

        await manager.start(created.terminal!);
        await manager.attach(created.terminal!.id);
        fake.emitData('discard with closing view');
        manager.detachAllViews();
        await new Promise((resolve) => setTimeout(resolve, 30));

        expect(output).toBe('');
        expect(manager.runningCount()).toBe(1);
        manager.close(created.terminal!.id);
        database.close();
    });

    it('classifies a signal-terminated PTY as an unexpected death even with exit code zero', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-pty-signal-exit-'));
        temporaryDirectories.push(directory);
        const database = new CaxriDatabase(join(directory, 'state.db'));
        const created = database.createSession(database.createProject(directory).id, 'shell');
        const fake = createFakePty();
        const manager = createTestTerminalManager(
            database,
            () => {},
            createTestLogger(join(directory, 'logs')),
            { resolveExecutable: () => Promise.resolve('/bin/zsh'), spawn: () => fake.process },
        );

        await manager.start(created.terminal!);
        fake.emitExit({ exitCode: 0, signal: 9 });

        await vi.waitFor(() =>
            expect(database.getTerminal(created.terminal!.id)?.lastProcessState).toBe('dead'),
        );
        database.close();
    });

    it('reattaches from the current cursor-addressed screen after raw output exceeds retention', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-pty-detached-screen-'));
        temporaryDirectories.push(directory);
        const database = new CaxriDatabase(join(directory, 'state.db'));
        const created = database.createSession(database.createProject(directory).id, 'codex');
        const fake = createFakePty();
        const manager = createTestTerminalManager(
            database,
            () => {},
            createTestLogger(join(directory, 'logs')),
            {
                resolveExecutable: (kind) =>
                    Promise.resolve(kind === 'shell' ? '/bin/zsh' : '/bin/echo'),
                spawn: () => fake.process,
            },
        );

        await manager.start(created.terminal!);
        await manager.attach(created.terminal!.id);
        manager.detachView(created.terminal!.id);
        fake.emitData('\u{1B}[2J\u{1B}[HRETAINED_HEADER');
        const cursorUpdate = '\u{1B}[2;1Hprogress';
        fake.emitData(cursorUpdate.repeat(1_000));

        const snapshot = await manager.attach(created.terminal!.id);
        expect(snapshot?.payload.includes('RETAINED_HEADER')).toBe(true);

        manager.close(created.terminal!.id);
        database.close();
    });
});
