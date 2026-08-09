import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { basename, join } from 'node:path';

import type { IPty, spawn as spawnPty } from 'node-pty';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { RuntimeEvent } from '../../shared/ipc';
import { listLayoutTerminalIds } from '../../shared/terminal-layout';
import { StructuredLogger } from '../../shared/node/logger';
import { createRuntime } from '../bootstrap';
import { CaxriDatabase } from '../db/repository';

const temporaryDirectories: string[] = [];

/** A PTY stub keeps the in-process Runtime hermetic: no login shell is launched by these tests. */
function createFakePty(): IPty {
    return {
        pid: 4242,
        kill: vi.fn(),
        onData: vi.fn(() => ({ dispose: vi.fn() })),
        onExit: vi.fn(() => ({ dispose: vi.fn() })),
        resize: vi.fn(),
        write: vi.fn(),
    } as unknown as IPty;
}

afterEach(async () => {
    await Promise.all(
        temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
    );
});

describe('Runtime composition root', () => {
    it('applies provider settings through Runtime composition to a new Agent Terminal', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-runtime-agent-settings-'));
        temporaryDirectories.push(directory);
        const projectRoot = join(directory, 'project');
        await mkdir(projectRoot);
        const spawn = vi.fn<typeof spawnPty>(() => createFakePty());
        const runtime = await createRuntime({
            userDataPath: join(directory, 'user-data'),
            logger: new StructuredLogger(join(directory, 'logs')),
            send: () => undefined,
            terminal: {
                agentEnvironment: () =>
                    Promise.resolve({ HOME: directory, PATH: '/login/bin:/usr/bin' }),
                spawn,
            },
            agentAdapters: fakeAgentAdapters(),
        });

        try {
            const currentSettings = await runtime.handlers['settings.get']({});
            await runtime.handlers['settings.update']({
                source: JSON.stringify({
                    ...currentSettings.value,
                    'agents.providers': {
                        ...currentSettings.value['agents.providers'],
                        codex: {
                            launch: {
                                executable: '/bin/echo',
                                args: ['--profile', 'focused'],
                            },
                        },
                    },
                }),
            });
            const project = await runtime.handlers['project.create']({ rootPath: projectRoot });
            await runtime.handlers['session.create']({
                projectId: project.id,
                defaultAgent: 'codex',
            });
            const canonicalProjectRoot = await realpath(projectRoot);

            expect(spawn.mock.calls[0]?.[0]).toBe('/bin/echo');
            expect(spawn.mock.calls[0]?.[1]).toEqual(['--profile', 'focused']);
            expect(spawn.mock.calls[0]?.[2]).toMatchObject({ cwd: canonicalProjectRoot });
            expect(spawn.mock.calls[0]?.[2].env).toMatchObject({
                PATH: '/login/bin:/usr/bin',
            });
        } finally {
            await runtime.close();
        }
    });

    it('applies the configured cwd only to new Terminals and preserves recorded cwd on restart', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-runtime-cwd-'));
        const homeDirectory = await mkdtemp(join(homedir(), '.caxri-runtime-cwd-'));
        temporaryDirectories.push(directory, homeDirectory);
        const projectRoot = join(directory, 'project');
        const customRoot = join(directory, 'custom');
        const changedRoot = join(directory, 'changed');
        await Promise.all([mkdir(projectRoot), mkdir(customRoot), mkdir(changedRoot)]);
        const spawn = vi.fn<typeof spawnPty>(() => createFakePty());
        const runtime = await createRuntime({
            userDataPath: join(directory, 'user-data'),
            logger: new StructuredLogger(join(directory, 'logs')),
            send: () => undefined,
            terminal: {
                resolveExecutable: () => Promise.resolve('/bin/zsh'),
                spawn,
            },
        });

        try {
            const project = await runtime.handlers['project.create']({ rootPath: projectRoot });
            const original = await runtime.handlers['session.create']({
                projectId: project.id,
                defaultAgent: 'shell',
            });
            expect(original.terminal.cwd).toBe(project.rootPath);

            const currentSettings = await runtime.handlers['settings.get']({});
            await runtime.handlers['settings.update']({
                source: JSON.stringify({
                    ...currentSettings.value,
                    'terminal.defaultWorkingDirectory': customRoot,
                }),
            });
            const customized = await runtime.handlers['session.create']({
                projectId: project.id,
                defaultAgent: 'shell',
            });
            const additional = await runtime.handlers['terminal.create']({
                sessionId: customized.session.id,
                kind: 'shell',
            });
            const canonicalCustomRoot = await realpath(customRoot);
            expect(customized.terminal.cwd).toBe(canonicalCustomRoot);
            expect(additional.cwd).toBe(canonicalCustomRoot);

            await runtime.handlers['settings.update']({
                source: JSON.stringify({
                    ...currentSettings.value,
                    'terminal.defaultWorkingDirectory': changedRoot,
                }),
            });
            await runtime.handlers['terminal.restart']({ terminalId: additional.id });
            expect(spawn.mock.calls.at(-1)?.[2]).toMatchObject({ cwd: canonicalCustomRoot });

            await runtime.handlers['settings.update']({
                source: JSON.stringify({
                    ...currentSettings.value,
                    'terminal.defaultWorkingDirectory': `~/${basename(homeDirectory)}`,
                }),
            });
            const homeTerminal = await runtime.handlers['terminal.create']({
                sessionId: customized.session.id,
                kind: 'shell',
            });
            expect(homeTerminal.cwd).toBe(homeDirectory);

            await runtime.handlers['settings.update']({
                source: JSON.stringify({
                    ...currentSettings.value,
                    'terminal.defaultWorkingDirectory': join(directory, 'missing'),
                }),
            });
            const spawnCount = spawn.mock.calls.length;
            await expect(
                runtime.handlers['terminal.create']({
                    sessionId: customized.session.id,
                    kind: 'shell',
                }),
            ).rejects.toMatchObject({ code: 'IO' });
            expect(spawn).toHaveBeenCalledTimes(spawnCount);
        } finally {
            await runtime.close();
        }
    });

    it('renames a Session through typed Runtime IPC and persists manual ownership', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-runtime-session-rename-'));
        temporaryDirectories.push(directory);
        const projectRoot = join(directory, 'project');
        await mkdir(projectRoot);
        const runtime = await createRuntime({
            userDataPath: join(directory, 'user-data'),
            logger: new StructuredLogger(join(directory, 'logs')),
            send: () => undefined,
            terminal: {
                resolveExecutable: () => Promise.resolve('/bin/zsh'),
                spawn: () => createFakePty(),
            },
        });

        try {
            const project = await runtime.handlers['project.create']({ rootPath: projectRoot });
            const created = await runtime.handlers['session.create']({
                projectId: project.id,
                defaultAgent: 'shell',
            });
            expect(
                runtime.handlers['session.rename']({
                    sessionId: created.session.id,
                    displayTitle: '  Focused investigation  ',
                }),
            ).toMatchObject({
                displayTitle: 'Focused investigation',
                titleMode: 'manual',
            });
            expect(() =>
                runtime.handlers['session.rename']({
                    sessionId: created.session.id,
                    displayTitle: '   ',
                }),
            ).toThrow(expect.objectContaining({ code: 'VALIDATION' }));
        } finally {
            await runtime.close();
        }
    });

    it('serves a Project, Session, and Files workflow through the handler table', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-runtime-'));
        temporaryDirectories.push(directory);
        const projectRoot = join(directory, 'project');
        await mkdir(projectRoot);
        await writeFile(join(projectRoot, 'README.md'), '# Caxri\n', 'utf8');
        const events: RuntimeEvent[] = [];
        const runtime = await createRuntime({
            userDataPath: join(directory, 'user-data'),
            logger: new StructuredLogger(join(directory, 'logs')),
            send: (event) => events.push(event),
            startedAt: 1_700_000_000_000,
            pid: 1234,
            terminal: {
                resolveExecutable: () => Promise.resolve('/bin/zsh'),
                spawn: () => createFakePty(),
            },
        });
        const { handlers } = runtime;

        try {
            expect(await handlers['app.health']({})).toEqual({
                ready: true,
                pid: 1234,
                startedAt: 1_700_000_000_000,
                activePtyCount: 0,
            });
            const empty = await handlers['app.bootstrap']({});
            expect(empty).toMatchObject({
                projects: [],
                sessions: [],
                terminals: [],
                runtime: { status: 'ready', restartCount: 0 },
            });
            expect(empty.theme.id).toBe('dracula');

            const project = await handlers['project.create']({ rootPath: projectRoot });
            expect(project).toMatchObject({ displayTitle: 'project' });
            const created = await handlers['session.create']({
                projectId: project.id,
                defaultAgent: 'shell',
            });
            expect(created.session.projectId).toBe(project.id);
            expect(created.terminal.lastProcessState).toBe('running');

            const entries = await handlers['files.list']({ sessionId: created.session.id });
            expect(entries.map((entry) => entry.name)).toContain('README.md');
            const document = await handlers['files.read']({
                sessionId: created.session.id,
                path: join(project.rootPath, 'README.md'),
            });
            expect(document.content).toBe('# Caxri\n');

            const populated = await handlers['app.bootstrap']({});
            expect(populated.projects).toHaveLength(1);
            expect(populated.sessions).toHaveLength(1);
            expect(populated.selectedSessionId).toBe(created.session.id);
            /** Live PTY identity is Runtime state, not durable metadata, so it must come from the manager. */
            expect(populated.terminals[0]).toMatchObject({
                id: created.terminal.id,
                processId: 4242,
            });
            expect(await handlers['terminal.runningCount']({})).toBe(1);
            expect(
                await handlers['app.records']({
                    sessionIds: [created.session.id],
                    terminalIds: [created.terminal.id],
                }),
            ).toMatchObject({
                sessions: [{ id: created.session.id }],
                terminals: [{ id: created.terminal.id, processId: 4242 }],
            });

            const remaining = await handlers['session.delete']({ sessionId: created.session.id });
            /** Session deletion removes Session metadata only; the Project keeps its durable root. */
            expect(remaining).toMatchObject({
                sessions: [],
                terminals: [],
                projects: [{ id: project.id, rootPath: project.rootPath }],
            });
            expect(await handlers['terminal.runningCount']({})).toBe(0);

            expect(
                events
                    .filter((event) => event.event === 'state.changed')
                    .map((event) =>
                        event.payload.kind === 'full' ? event.payload.reason : event.payload.kind,
                    ),
            ).toEqual(['project.create', 'session.create', 'session.delete']);

            expect(
                await handlers['app.records']({
                    sessionIds: [created.session.id, 'missing-session'],
                    terminalIds: [created.terminal.id, 'missing-terminal'],
                }),
            ).toEqual({ sessions: [], terminals: [] });
        } finally {
            await runtime.close();
        }
    });

    it('reports a missing Session as NOT_FOUND and keeps the Runtime usable', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-runtime-errors-'));
        temporaryDirectories.push(directory);
        const runtime = await createRuntime({
            userDataPath: join(directory, 'user-data'),
            logger: new StructuredLogger(join(directory, 'logs')),
            send: () => undefined,
        });

        try {
            await expect(
                runtime.handlers['files.list']({ sessionId: 'missing-session' }),
            ).rejects.toMatchObject({ code: 'NOT_FOUND' });
            expect(await runtime.handlers['settings.get']({})).toMatchObject({
                value: { 'terminal.fontSize': 13 },
            });
        } finally {
            await runtime.close();
        }
    });

    it('closes every owned resource once, so shutdown can run twice', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-runtime-shutdown-'));
        temporaryDirectories.push(directory);
        const runtime = await createRuntime({
            userDataPath: join(directory, 'user-data'),
            logger: new StructuredLogger(join(directory, 'logs')),
            send: () => undefined,
        });

        expect(await runtime.handlers['runtime.shutdown']({})).toBeNull();
        await expect(runtime.close()).resolves.toBeUndefined();
    });
});

/** No-op stub: the resume-restore workflow only needs `updateAgentMetadata` to stay a no-op so the
    directly-written `agent_session_id` (see below) is never overwritten by a real probe result. */
function fakeAgentAdapters(): Record<
    'claude' | 'codex',
    { provider: 'claude' | 'codex'; snapshot: () => Promise<never> }
> {
    const pending = new Promise<never>(() => undefined);
    return {
        claude: { provider: 'claude', snapshot: () => pending },
        codex: { provider: 'codex', snapshot: () => pending },
    };
}

describe('Interrupted Terminal auto-restore (GitHub issue #18)', () => {
    it('resumes a claude Terminal interrupted by an orderly shutdown with its bound Agent session id', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-runtime-restore-'));
        temporaryDirectories.push(directory);
        const userDataPath = join(directory, 'user-data');
        const projectRoot = join(directory, 'project');
        await mkdir(projectRoot);
        const resolveExecutable = () => Promise.resolve('/usr/local/bin/claude');

        const runtimeA = await createRuntime({
            userDataPath,
            logger: new StructuredLogger(join(directory, 'logs-a')),
            send: () => undefined,
            terminal: { resolveExecutable, spawn: () => createFakePty() },
            agentAdapters: fakeAgentAdapters(),
        });
        const project = await runtimeA.handlers['project.create']({ rootPath: projectRoot });
        const created = await runtimeA.handlers['session.create']({
            projectId: project.id,
            defaultAgent: 'claude',
        });
        expect(created.terminal.provider).toBe('claude');
        /** Orderly close marks the still-running Terminal `interrupted`, not `stopped`/`dead`. */
        await runtimeA.close();

        /** Simulate a capability-detected Agent session id having been bound before the shutdown; done
            through the raw better-sqlite3 handle because `updateAgentMetadata` requires a matching
            provider snapshot, which this hermetic test does not produce. */
        const direct = new CaxriDatabase(join(userDataPath, 'caxri.db'));
        expect(direct.getTerminal(created.terminal.id)?.lastProcessState).toBe('interrupted');
        direct.database
            .prepare('UPDATE terminals SET agent_session_id = ? WHERE id = ?')
            .run('sess-resume-1', created.terminal.id);
        direct.close();

        const spawnSpy = vi.fn();
        spawnSpy.mockImplementation(() => createFakePty());
        const runtimeB = await createRuntime({
            userDataPath,
            logger: new StructuredLogger(join(directory, 'logs-b')),
            send: () => undefined,
            terminal: { resolveExecutable, spawn: spawnSpy },
            agentAdapters: fakeAgentAdapters(),
        });
        try {
            await vi.waitFor(() => expect(spawnSpy).toHaveBeenCalled());
            expect(spawnSpy.mock.calls[0]?.[1]).toEqual(['--resume', 'sess-resume-1']);

            const bootstrap = await vi.waitFor(async () => {
                const state = await runtimeB.handlers['app.bootstrap']({});
                const terminal = state.terminals.find((entry) => entry.id === created.terminal.id);
                expect(terminal?.lastProcessState).toBe('running');
                return state;
            });
            const restoredTerminal = bootstrap.terminals.find(
                (entry) => entry.id === created.terminal.id,
            );
            expect(restoredTerminal?.agentSessionId).toBe('sess-resume-1');
        } finally {
            await runtimeB.close();
        }
    });

    it("restores a Session's interrupted Terminals concurrently", async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-runtime-restore-concurrent-'));
        temporaryDirectories.push(directory);
        const userDataPath = join(directory, 'user-data');
        const projectRoot = join(directory, 'project');
        await mkdir(projectRoot);

        const runtimeA = await createRuntime({
            userDataPath,
            logger: new StructuredLogger(join(directory, 'logs-a')),
            send: () => undefined,
            terminal: {
                resolveExecutable: () => Promise.resolve('/bin/zsh'),
                spawn: () => createFakePty(),
            },
        });
        const project = await runtimeA.handlers['project.create']({ rootPath: projectRoot });
        const created = await runtimeA.handlers['session.create']({
            projectId: project.id,
            defaultAgent: 'shell',
        });
        const second = await runtimeA.handlers['terminal.create']({
            sessionId: created.session.id,
            kind: 'shell',
        });
        await runtimeA.close();

        let releaseDiscovery = (): void => undefined;
        const discoveryGate = new Promise<void>((resolve) => {
            releaseDiscovery = resolve;
        });
        const resolveExecutable = vi.fn(async () => {
            await discoveryGate;
            return '/bin/zsh';
        });
        const spawnSpy = vi.fn(() => createFakePty());
        const events: RuntimeEvent[] = [];
        const runtimeB = await createRuntime({
            userDataPath,
            logger: new StructuredLogger(join(directory, 'logs-b')),
            send: (event) => events.push(event),
            terminal: { resolveExecutable, spawn: spawnSpy },
        });
        try {
            await vi.waitFor(() => expect(resolveExecutable).toHaveBeenCalledTimes(2));
            releaseDiscovery();
            await vi.waitFor(() => expect(spawnSpy).toHaveBeenCalledTimes(2));
            await vi.waitFor(() => {
                const restored = events.find(
                    (event) =>
                        event.event === 'state.changed' &&
                        event.payload.kind === 'records' &&
                        event.payload.terminalIds.length === 2,
                );
                if (
                    !restored ||
                    restored.event !== 'state.changed' ||
                    restored.payload.kind !== 'records'
                )
                    throw new Error('Missing scoped restore event');
                expect(new Set(restored.payload.terminalIds)).toEqual(
                    new Set([created.terminal.id, second.id]),
                );
            });
        } finally {
            releaseDiscovery();
            await runtimeB.close();
        }
    });

    it('restarts an interrupted Agent Terminal without a bound session fresh, and never auto-restarts an explicitly terminated one', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-runtime-restore-fresh-'));
        temporaryDirectories.push(directory);
        const userDataPath = join(directory, 'user-data');
        const projectRoot = join(directory, 'project');
        await mkdir(projectRoot);
        const resolveExecutable = () => Promise.resolve('/usr/local/bin/claude');

        const runtimeA = await createRuntime({
            userDataPath,
            logger: new StructuredLogger(join(directory, 'logs-a')),
            send: () => undefined,
            terminal: { resolveExecutable, spawn: () => createFakePty() },
            agentAdapters: fakeAgentAdapters(),
        });
        const project = await runtimeA.handlers['project.create']({ rootPath: projectRoot });
        const created = await runtimeA.handlers['session.create']({
            projectId: project.id,
            defaultAgent: 'claude',
        });
        /** No Agent session id was ever bound, so the orderly close leaves `agentSessionId` unset. */
        await runtimeA.close();

        const freshSpawnSpy = vi.fn();
        freshSpawnSpy.mockImplementation(() => createFakePty());
        const runtimeB = await createRuntime({
            userDataPath,
            logger: new StructuredLogger(join(directory, 'logs-b')),
            send: () => undefined,
            terminal: { resolveExecutable, spawn: freshSpawnSpy },
            agentAdapters: fakeAgentAdapters(),
        });
        try {
            await vi.waitFor(() => expect(freshSpawnSpy).toHaveBeenCalled());
            expect(freshSpawnSpy.mock.calls[0]?.[1]).toEqual([]);

            await runtimeB.handlers['terminal.terminateAll']({});
            const afterTerminate = await runtimeB.handlers['app.bootstrap']({});
            expect(
                afterTerminate.terminals.find((entry) => entry.id === created.terminal.id)
                    ?.lastProcessState,
            ).toBe('stopped');
        } finally {
            await runtimeB.close();
        }

        const noRestartSpawnSpy = vi.fn();
        noRestartSpawnSpy.mockImplementation(() => createFakePty());
        const runtimeC = await createRuntime({
            userDataPath,
            logger: new StructuredLogger(join(directory, 'logs-c')),
            send: () => undefined,
            terminal: { resolveExecutable, spawn: noRestartSpawnSpy },
            agentAdapters: fakeAgentAdapters(),
        });
        try {
            /** Give the fire-and-forget restore a beat to (not) run before asserting it stayed idle. */
            await new Promise((resolve) => setTimeout(resolve, 50));
            expect(noRestartSpawnSpy).not.toHaveBeenCalled();
        } finally {
            await runtimeC.close();
        }
    });
});

describe('selected Session Agent probes', () => {
    it('probes only the selected Session at boot and defers another Session until selection', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-runtime-selected-probes-'));
        temporaryDirectories.push(directory);
        const userDataPath = join(directory, 'user-data');
        const projectRoot = join(directory, 'project');
        await mkdir(projectRoot);

        const runtimeA = await createRuntime({
            userDataPath,
            logger: new StructuredLogger(join(directory, 'logs-a')),
            send: () => undefined,
            terminal: {
                resolveExecutable: () => Promise.resolve('/usr/local/bin/claude'),
                spawn: () => createFakePty(),
            },
            agentAdapters: fakeAgentAdapters(),
        });
        const project = await runtimeA.handlers['project.create']({ rootPath: projectRoot });
        const first = await runtimeA.handlers['session.create']({
            projectId: project.id,
            defaultAgent: 'claude',
        });
        const selected = await runtimeA.handlers['session.create']({
            projectId: project.id,
            defaultAgent: 'claude',
        });
        await runtimeA.handlers['terminal.terminateAll']({});
        await runtimeA.close();

        const snapshot = vi.fn((context: { correlationId?: string }) =>
            Promise.resolve({
                provider: 'claude' as const,
                status: 'completed' as const,
                observedAt: Date.now(),
                available: true,
                sessionId: context.correlationId,
            }),
        );
        const pending = new Promise<never>(() => undefined);
        const runtimeB = await createRuntime({
            userDataPath,
            logger: new StructuredLogger(join(directory, 'logs-b')),
            send: () => undefined,
            agentAdapters: {
                claude: { provider: 'claude', snapshot },
                codex: { provider: 'codex', snapshot: () => pending },
            },
        });

        try {
            await vi.waitFor(() => expect(snapshot).toHaveBeenCalledTimes(1));
            expect(snapshot.mock.calls[0]?.[0].correlationId).toBe(selected.terminal.id);

            await runtimeB.handlers['session.select']({ sessionId: first.session.id });
            await vi.waitFor(() => expect(snapshot).toHaveBeenCalledTimes(2));
            expect(snapshot.mock.calls[1]?.[0].correlationId).toBe(first.terminal.id);
        } finally {
            await runtimeB.close();
        }
    });
});

describe('Session state recovery', () => {
    it('repairs corrupt Session JSON, logs the reason, and keeps bootstrap available', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-runtime-state-repair-'));
        temporaryDirectories.push(directory);
        const userDataPath = join(directory, 'user-data');
        const projectRoot = join(directory, 'project');
        await mkdir(projectRoot);
        const runtimeA = await createRuntime({
            userDataPath,
            logger: new StructuredLogger(join(directory, 'logs-a')),
            send: () => undefined,
            terminal: {
                resolveExecutable: () => Promise.resolve('/bin/zsh'),
                spawn: () => createFakePty(),
            },
        });
        const project = await runtimeA.handlers['project.create']({ rootPath: projectRoot });
        const created = await runtimeA.handlers['session.create']({
            projectId: project.id,
            defaultAgent: 'shell',
        });
        await runtimeA.close();

        const direct = new CaxriDatabase(join(userDataPath, 'caxri.db'));
        direct.database
            .prepare('UPDATE session_state SET layout_json = ? WHERE session_id = ?')
            .run('{', created.session.id);
        direct.close();

        const logger = new StructuredLogger(join(directory, 'logs-b'));
        const runtimeB = await createRuntime({ userDataPath, logger, send: () => undefined });
        try {
            const bootstrap = await runtimeB.handlers['app.bootstrap']({});
            const repaired = bootstrap.sessionStates.find(
                (state) => state.sessionId === created.session.id,
            );
            expect(repaired).toMatchObject({ openTabs: [], inspectorMode: 'files' });
            expect(listLayoutTerminalIds(repaired?.layout ?? {})).toEqual([created.terminal.id]);

            const records = (await readFile(logger.path, 'utf8'))
                .trim()
                .split('\n')
                .map((line) => JSON.parse(line) as unknown as Record<string, unknown>);
            const repairRecord = records.find(
                (record) => record.event === 'db.session_state_repaired',
            );
            expect(repairRecord).toMatchObject({ level: 'warn' });
            expect(repairRecord?.fields).toEqual(
                expect.objectContaining({
                    sessionId: created.session.id,
                    reason: 'invalid_json',
                }),
            );
        } finally {
            await runtimeB.close();
        }
    });
});
