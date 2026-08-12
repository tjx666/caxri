import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { IPty, spawn as spawnPty } from 'node-pty';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { StructuredLogger } from '../../../shared/node/logger';
import type { AgentLaunchSettings } from '../../../shared/agents';
import type { TerminalKind } from '../../../shared/types';
import { CaxriDatabase } from '../../db/repository';
import { MAX_SNAPSHOT_BYTES } from '../../snapshot';
import { TerminalManager } from '..';
import { TERMINAL_IMAGE_RECOVERY_PLACEHOLDER } from '../image-recovery';

const temporaryDirectories: string[] = [];

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
    const process = {
        get cols() {
            return cols;
        },
        kill,
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
        write: vi.fn(),
    } as unknown as IPty;
    return {
        emitData: (data: string) => onData?.(data),
        emitExit: (event: { exitCode: number; signal?: number }) => onExit?.(event),
        kill,
        process,
        resize,
    };
}

afterEach(async () => {
    vi.unstubAllEnvs();
    await Promise.all(
        temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
    );
});

describe('TerminalManager', () => {
    it('injects and revokes a fresh lifecycle environment for each PTY generation', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-pty-lifecycle-'));
        temporaryDirectories.push(directory);
        const database = new CaxriDatabase(join(directory, 'state.db'));
        const created = database.createSession(database.createProject(directory).id, 'shell');
        const spawned: ReturnType<typeof createFakePty>[] = [];
        const spawn = vi.fn<typeof spawnPty>(() => {
            const fake = createFakePty();
            spawned.push(fake);
            return fake.process;
        });
        let generation = 0;
        const retired = vi.fn();
        const manager = new TerminalManager(
            database,
            () => undefined,
            new StructuredLogger(join(directory, 'logs')),
            {
                lifecycleEnvironment: () => ({
                    CAXRI_HOOK_LAUNCH_ID: `launch-${(generation += 1)}`,
                    CAXRI_HOOK_TOKEN: `token-${generation}`,
                }),
                onLifecycleRetired: retired,
                resolveExecutable: () => Promise.resolve('/bin/zsh'),
                spawn,
            },
        );

        try {
            await manager.start(created.terminal);
            expect(spawn.mock.calls[0]?.[2].env).toMatchObject({
                CAXRI_HOOK_LAUNCH_ID: 'launch-1',
                CAXRI_HOOK_TOKEN: 'token-1',
            });

            await manager.restart(created.terminal.id);
            expect(retired).toHaveBeenCalledWith(created.terminal.id);
            expect(spawn.mock.calls[1]?.[2].env).toMatchObject({
                CAXRI_HOOK_LAUNCH_ID: 'launch-2',
                CAXRI_HOOK_TOKEN: 'token-2',
            });
        } finally {
            manager.close(created.terminal.id);
            database.close();
        }
    });

    it('composes configured Agent argv with resume args and uses the filtered login environment', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-pty-agent-launch-'));
        temporaryDirectories.push(directory);
        const database = new CaxriDatabase(join(directory, 'state.db'));
        const created = database.createSession(database.createProject(directory).id, 'codex');
        const spawned: ReturnType<typeof createFakePty>[] = [];
        const spawn = vi.fn<typeof spawnPty>(() => {
            const fake = createFakePty();
            spawned.push(fake);
            return fake.process;
        });
        const manager = new TerminalManager(
            database,
            () => undefined,
            new StructuredLogger(join(directory, 'logs')),
            {
                agentLaunchSettings: () => ({
                    executable: '/bin/echo',
                    args: ['--profile', 'focused'],
                }),
                agentEnvironment: () =>
                    Promise.resolve({ HOME: directory, PATH: '/login/bin:/usr/bin' }),
                spawn,
            },
        );

        try {
            await manager.start(created.terminal);
            expect(spawn.mock.calls[0]?.[0]).toBe('/bin/echo');
            expect(spawn.mock.calls[0]?.[1]).toEqual(['--profile', 'focused']);
            expect(spawn.mock.calls[0]?.[2]).toMatchObject({
                cwd: directory,
                env: {
                    COLORTERM: 'truecolor',
                    HOME: directory,
                    PATH: '/login/bin:/usr/bin',
                    TERM: 'xterm-256color',
                },
            });

            await manager.restart(created.terminal.id, {
                resumeAgentSessionId: 'conversation-1',
            });
            expect(spawn).toHaveBeenNthCalledWith(
                2,
                '/bin/echo',
                ['--profile', 'focused', 'resume', 'conversation-1'],
                expect.any(Object),
            );
        } finally {
            for (const fake of spawned) fake.kill();
            manager.close(created.terminal.id);
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
        const manager = new TerminalManager(
            database,
            () => undefined,
            new StructuredLogger(join(directory, 'logs')),
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
                manager.start(created.terminal, { resumeAgentSessionId: 'persisted-session' }),
            ).rejects.toThrow('does not resume persisted Agent sessions');
            expect(spawn).not.toHaveBeenCalled();
        } finally {
            manager.close(created.terminal.id);
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
        let finishResolution: (() => void) | undefined;
        const resolutionPending = new Promise<void>((resolve) => {
            finishResolution = resolve;
        });
        const resolveExecutable = vi.fn(
            async (_kind: TerminalKind, settings?: AgentLaunchSettings) => {
                await resolutionPending;
                if (!settings) throw new Error('Agent launch settings are required');
                return settings.executable;
            },
        );
        const manager = new TerminalManager(
            database,
            () => undefined,
            new StructuredLogger(join(directory, 'logs')),
            {
                agentEnvironment: () => Promise.resolve({ PATH: '/usr/bin' }),
                agentLaunchSettings: () => launch,
                resolveExecutable,
                spawn,
            },
        );

        try {
            const starting = manager.start(created.terminal);
            await vi.waitFor(() => expect(resolveExecutable).toHaveBeenCalledOnce());
            launch = { executable: '/new/codex', args: ['--new-profile'] };
            finishResolution!();
            await starting;

            expect(resolveExecutable).toHaveBeenCalledWith('codex', {
                executable: '/old/codex',
                args: ['--old-profile'],
            });
            expect(spawn).toHaveBeenCalledWith('/old/codex', ['--old-profile'], expect.any(Object));
        } finally {
            fake.kill();
            manager.close(created.terminal.id);
            database.close();
        }
    });

    it('contains an immediately failing Agent child to its durable Terminal', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-pty-agent-fast-failure-'));
        temporaryDirectories.push(directory);
        const database = new CaxriDatabase(join(directory, 'state.db'));
        const created = database.createSession(database.createProject(directory).id, 'codex');
        const failed = createFakePty();
        const manager = new TerminalManager(
            database,
            () => undefined,
            new StructuredLogger(join(directory, 'logs')),
            {
                resolveExecutable: () => Promise.resolve('/bin/echo'),
                spawn: () => failed.process,
            },
        );

        await manager.start(created.terminal);
        failed.emitExit({ exitCode: 127 });

        expect(database.getTerminal(created.terminal.id)?.lastProcessState).toBe('dead');
        expect(manager.runningCount()).toBe(0);
        expect(database.listProjects()).toHaveLength(1);
        database.close();
    });

    it('coalesces continuous output into one snapshot write per persistence interval', async () => {
        vi.useFakeTimers();
        const directory = await mkdtemp(join(tmpdir(), 'caxri-pty-snapshot-rate-'));
        temporaryDirectories.push(directory);
        const database = new CaxriDatabase(join(directory, 'state.db'));
        const created = database.createSession(database.createProject(directory).id, 'shell');
        const fake = createFakePty();
        const saveSnapshot = vi.spyOn(database, 'saveSnapshot');
        const manager = new TerminalManager(
            database,
            () => undefined,
            new StructuredLogger(join(directory, 'logs')),
            {
                resolveExecutable: () => Promise.resolve('/bin/zsh'),
                snapshotIntervalMs: 5_000,
                spawn: () => fake.process,
            },
        );

        try {
            await manager.start(created.terminal);
            for (let index = 0; index < 100; index += 1) fake.emitData(`line-${index}\n`);
            await vi.advanceTimersByTimeAsync(4_999);
            expect(saveSnapshot).not.toHaveBeenCalled();
            await vi.advanceTimersByTimeAsync(1);
            expect(saveSnapshot).toHaveBeenCalledOnce();
        } finally {
            manager.close(created.terminal.id);
            database.close();
            vi.useRealTimers();
        }
    });

    it('renders image bytes live but persists only a content-free recovery placeholder', async () => {
        vi.useFakeTimers();
        const directory = await mkdtemp(join(tmpdir(), 'caxri-pty-image-recovery-'));
        temporaryDirectories.push(directory);
        const database = new CaxriDatabase(join(directory, 'state.db'));
        const created = database.createSession(database.createProject(directory).id, 'shell');
        const fake = createFakePty();
        let output = '';
        const manager = new TerminalManager(
            database,
            (event) => {
                if (event.event === 'terminal.output') output += event.payload.data;
            },
            new StructuredLogger(join(directory, 'logs')),
            {
                resolveExecutable: () => Promise.resolve('/bin/zsh'),
                snapshotIntervalMs: 50,
                spawn: () => fake.process,
            },
        );

        try {
            await manager.start(created.terminal);
            await manager.attach(created.terminal.id);
            const image = '\x1b]1337;File=inline=1:PNG_SECRET\x07';
            fake.emitData(`before${image}after`);
            await vi.advanceTimersByTimeAsync(50);

            expect(output).toContain(image);
            expect(database.getSnapshot(created.terminal.id)?.payload).toBe(
                `before${TERMINAL_IMAGE_RECOVERY_PLACEHOLDER}after`,
            );
            expect(database.getSnapshot(created.terminal.id)?.payload).not.toContain('PNG_SECRET');
        } finally {
            manager.close(created.terminal.id);
            database.close();
            vi.useRealTimers();
        }
    });

    it('sanitizes a legacy image-bearing snapshot before restoring it', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-pty-image-migration-'));
        temporaryDirectories.push(directory);
        const database = new CaxriDatabase(join(directory, 'state.db'));
        const created = database.createSession(database.createProject(directory).id, 'shell');
        database.saveSnapshot({
            byteCount: 43,
            encodingVersion: 1,
            lineCount: 1,
            payload: 'before\x1b]1337;File=inline=1:OLD_SECRET\x07after',
            terminalId: created.terminal.id,
            updatedAt: Date.now(),
        });
        const fake = createFakePty();
        const manager = new TerminalManager(
            database,
            () => undefined,
            new StructuredLogger(join(directory, 'logs')),
            { resolveExecutable: () => Promise.resolve('/bin/zsh'), spawn: () => fake.process },
        );

        try {
            await manager.start(created.terminal);

            expect(database.getSnapshot(created.terminal.id)?.payload).toBe(
                `before${TERMINAL_IMAGE_RECOVERY_PLACEHOLDER}after`,
            );
        } finally {
            manager.close(created.terminal.id);
            database.close();
        }
    });

    it('does not register a PTY whose durable record was closed while spawn was pending', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-pty-pending-close-'));
        temporaryDirectories.push(directory);
        const database = new CaxriDatabase(join(directory, 'state.db'));
        const created = database.createSession(database.createProject(directory).id, 'shell');
        const executable = Promise.withResolvers<string>();
        const fake = createFakePty();
        const manager = new TerminalManager(
            database,
            () => undefined,
            new StructuredLogger(join(directory, 'logs')),
            {
                resolveExecutable: () => executable.promise,
                spawn: () => fake.process,
            },
        );

        const starting = manager.start(created.terminal);
        manager.close(created.terminal.id);
        executable.resolve('/bin/zsh');
        const result = await starting.catch((error: unknown) => error);

        try {
            expect(result).toBeInstanceOf(Error);
            expect(manager.runningCount()).toBe(0);
            expect(fake.kill).toHaveBeenCalledOnce();
        } finally {
            manager.close(created.terminal.id);
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
        const manager = new TerminalManager(
            database,
            () => undefined,
            new StructuredLogger(join(directory, 'logs')),
            { resolveExecutable: () => executable.promise, spawn },
        );
        let isCurrent = true;

        const starting = manager.start(created.terminal, { shouldStart: () => isCurrent });
        isCurrent = false;
        executable.resolve('/bin/zsh');

        try {
            await expect(starting).resolves.toMatchObject({ lastProcessState: 'interrupted' });
            expect(spawn).not.toHaveBeenCalled();
            expect(manager.runningCount()).toBe(0);
        } finally {
            manager.close(created.terminal.id);
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
        const manager = new TerminalManager(
            database,
            (event) => {
                if (event.event === 'terminal.output') output += event.payload.data;
            },
            new StructuredLogger(join(directory, 'logs')),
            { resolveExecutable: () => Promise.resolve('/bin/zsh'), spawn: () => fake.process },
        );

        await manager.start(created.terminal);
        await manager.attach(created.terminal.id);
        fake.emitData('queued exactly once');
        expect((await manager.attach(created.terminal.id))?.payload).toContain(
            'queued exactly once',
        );
        await new Promise((resolve) => setTimeout(resolve, 30));

        try {
            expect(output).toBe('');
        } finally {
            manager.close(created.terminal.id);
            database.close();
        }
    });

    it('does not resize a live PTY when its grid dimensions are unchanged', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-pty-resize-dedup-'));
        temporaryDirectories.push(directory);
        const database = new CaxriDatabase(join(directory, 'state.db'));
        const created = database.createSession(database.createProject(directory).id, 'shell');
        const fake = createFakePty();
        const manager = new TerminalManager(
            database,
            () => undefined,
            new StructuredLogger(join(directory, 'logs')),
            { resolveExecutable: () => Promise.resolve('/bin/zsh'), spawn: () => fake.process },
        );

        try {
            await manager.start(created.terminal);
            expect(manager.resize(created.terminal.id, 100, 30)).toBe(true);
            expect(fake.resize).not.toHaveBeenCalled();

            expect(manager.resize(created.terminal.id, 120, 40)).toBe(true);
            expect(manager.resize(created.terminal.id, 120, 40)).toBe(true);
            expect(fake.resize).toHaveBeenCalledOnce();
            expect(fake.resize).toHaveBeenCalledWith(120, 40);
        } finally {
            manager.close(created.terminal.id);
            database.close();
        }
    });

    it('resizes the Runtime screen to the Renderer grid before serializing an attachment', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-pty-attach-size-'));
        temporaryDirectories.push(directory);
        const database = new CaxriDatabase(join(directory, 'state.db'));
        const created = database.createSession(database.createProject(directory).id, 'shell');
        const fake = createFakePty();
        const manager = new TerminalManager(
            database,
            () => undefined,
            new StructuredLogger(join(directory, 'logs')),
            { resolveExecutable: () => Promise.resolve('/bin/zsh'), spawn: () => fake.process },
        );

        try {
            await manager.start(created.terminal);
            await manager.attach(created.terminal.id, { cols: 80, rows: 24 });

            expect(fake.resize).toHaveBeenCalledOnce();
            expect(fake.resize).toHaveBeenCalledWith(80, 24);
        } finally {
            manager.close(created.terminal.id);
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
        const manager = new TerminalManager(
            database,
            () => undefined,
            new StructuredLogger(join(directory, 'logs')),
            { resolveExecutable: () => Promise.resolve('/bin/zsh'), spawn },
        );

        try {
            await manager.attach(created.terminal.id, { cols: 132, rows: 41 });
            await manager.start(created.terminal);

            expect(spawn.mock.calls[0]?.[2]).toMatchObject({ cols: 132, rows: 41 });
        } finally {
            manager.close(created.terminal.id);
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
        const manager = new TerminalManager(
            database,
            () => undefined,
            new StructuredLogger(join(directory, 'logs')),
            { resolveExecutable: () => Promise.resolve('/bin/zsh'), spawn },
        );

        try {
            const starting = manager.start(created.terminal, { waitForAttachedSizeMs: 1_000 });
            await new Promise((resolve) => setTimeout(resolve, 0));
            expect(spawn).not.toHaveBeenCalled();

            await manager.attach(created.terminal.id, { cols: 132, rows: 41 });
            await starting;

            expect(spawn.mock.calls[0]?.[2]).toMatchObject({ cols: 132, rows: 41 });
        } finally {
            manager.close(created.terminal.id);
            database.close();
        }
    });

    it('cancels a pending restore grid wait during Runtime shutdown', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-pty-restore-grid-shutdown-'));
        temporaryDirectories.push(directory);
        const database = new CaxriDatabase(join(directory, 'state.db'));
        const created = database.createSession(database.createProject(directory).id, 'shell');
        const spawn = vi.fn<typeof spawnPty>(() => createFakePty().process);
        const manager = new TerminalManager(
            database,
            () => undefined,
            new StructuredLogger(join(directory, 'logs')),
            { resolveExecutable: () => Promise.resolve('/bin/zsh'), spawn },
        );
        let shouldStart = true;
        const starting = manager.start(created.terminal, {
            shouldStart: () => shouldStart,
            waitForAttachedSizeMs: 100,
        });

        try {
            await new Promise((resolve) => setTimeout(resolve, 0));
            shouldStart = false;
            manager.shutdown('orderly');

            const completedBeforeTimeout = await Promise.race([
                starting.then(() => true),
                new Promise<false>((resolve) => setTimeout(() => resolve(false), 20)),
            ]);
            expect(completedBeforeTimeout).toBe(true);
            expect(spawn).not.toHaveBeenCalled();
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
        const manager = new TerminalManager(
            database,
            () => undefined,
            new StructuredLogger(join(directory, 'logs')),
            { resolveExecutable: () => Promise.resolve('/bin/zsh'), spawn },
        );
        const cancellation = new AbortController();
        const starting = manager.start(created.terminal, {
            abortSignal: cancellation.signal,
            shouldStart: () => !cancellation.signal.aborted,
            waitForAttachedSizeMs: 100,
        });

        try {
            await new Promise((resolve) => setTimeout(resolve, 0));
            cancellation.abort();

            const completedBeforeTimeout = await Promise.race([
                starting.then(() => true),
                new Promise<false>((resolve) => setTimeout(() => resolve(false), 20)),
            ]);
            expect(completedBeforeTimeout).toBe(true);
            expect(spawn).not.toHaveBeenCalled();
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
        const manager = new TerminalManager(
            database,
            (event) => {
                if (event.event === 'terminal.output') output += event.payload.data;
            },
            new StructuredLogger(join(directory, 'logs')),
            { resolveExecutable: () => Promise.resolve('/bin/zsh'), spawn: () => fake.process },
        );

        await manager.start(created.terminal);
        await manager.attach(created.terminal.id);
        fake.emitData('discard with closing view');
        manager.detachAllViews();
        await new Promise((resolve) => setTimeout(resolve, 30));

        expect(output).toBe('');
        expect(manager.runningCount()).toBe(1);
        manager.close(created.terminal.id);
        database.close();
    });

    it('classifies a signal-terminated PTY as an unexpected death even with exit code zero', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-pty-signal-exit-'));
        temporaryDirectories.push(directory);
        const database = new CaxriDatabase(join(directory, 'state.db'));
        const created = database.createSession(database.createProject(directory).id, 'shell');
        const fake = createFakePty();
        const manager = new TerminalManager(
            database,
            () => undefined,
            new StructuredLogger(join(directory, 'logs')),
            { resolveExecutable: () => Promise.resolve('/bin/zsh'), spawn: () => fake.process },
        );

        await manager.start(created.terminal);
        fake.emitExit({ exitCode: 0, signal: 9 });

        expect(database.getTerminal(created.terminal.id)?.lastProcessState).toBe('dead');
        database.close();
    });

    it('buffers detached output in the snapshot and emits only after attachment', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-pty-detached-'));
        temporaryDirectories.push(directory);
        const database = new CaxriDatabase(join(directory, 'state.db'));
        const created = database.createSession(database.createProject(directory).id, 'shell');
        let output = '';
        const onOutputActivity = vi.fn();
        const manager = new TerminalManager(
            database,
            (event) => {
                if (event.event === 'terminal.output') output += event.payload.data;
            },
            new StructuredLogger(join(directory, 'logs')),
            { onOutputActivity, snapshotIntervalMs: 50 },
        );

        await manager.start(created.terminal);
        manager.write(created.terminal.id, "printf 'DETACHED_ONLY\\n'\r");
        await expect
            .poll(() => database.getSnapshot(created.terminal.id)?.payload)
            .toContain('DETACHED_ONLY');
        expect(onOutputActivity).toHaveBeenCalledWith(created.terminal.id, expect.any(Number));
        expect(output).not.toContain('DETACHED_ONLY');
        expect((await manager.attach(created.terminal.id))?.payload).toContain('DETACHED_ONLY');

        manager.write(created.terminal.id, "printf 'ATTACHED_OUTPUT\\n'\r");
        await expect.poll(() => output).toContain('ATTACHED_OUTPUT');
        manager.detachView(created.terminal.id);
        manager.write(created.terminal.id, "printf 'DETACHED_AGAIN\\n'\r");
        await expect
            .poll(() => database.getSnapshot(created.terminal.id)?.payload)
            .toContain('DETACHED_AGAIN');
        expect(output).not.toContain('DETACHED_AGAIN');

        manager.shutdown('orderly');
        database.close();
    });

    it('reattaches from the current cursor-addressed screen after raw output exceeds retention', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-pty-detached-screen-'));
        temporaryDirectories.push(directory);
        const database = new CaxriDatabase(join(directory, 'state.db'));
        const created = database.createSession(database.createProject(directory).id, 'codex');
        const fake = createFakePty();
        const manager = new TerminalManager(
            database,
            () => undefined,
            new StructuredLogger(join(directory, 'logs')),
            { resolveExecutable: () => Promise.resolve('/bin/echo'), spawn: () => fake.process },
        );

        await manager.start(created.terminal);
        await manager.attach(created.terminal.id);
        manager.detachView(created.terminal.id);
        fake.emitData('\u001B[2J\u001B[HRETAINED_HEADER');
        const cursorUpdate = '\u001B[2;1Hprogress';
        fake.emitData(
            cursorUpdate.repeat(Math.ceil((MAX_SNAPSHOT_BYTES + 65_536) / cursorUpdate.length)),
        );

        const snapshot = await manager.attach(created.terminal.id);
        expect(snapshot?.payload.includes('RETAINED_HEADER')).toBe(true);

        manager.close(created.terminal.id);
        database.close();
    });
});
