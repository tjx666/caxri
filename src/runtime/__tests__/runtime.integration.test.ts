import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { IPty } from 'node-pty';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { RuntimeEvent } from '../../shared/ipc';
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
                    .map((event) => event.payload.reason),
            ).toEqual(['project.create', 'session.create', 'session.delete']);
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
