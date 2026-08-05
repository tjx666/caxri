import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { IPty } from 'node-pty';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { RuntimeEvent } from '../../shared/ipc';
import { StructuredLogger } from '../../shared/node/logger';
import { createRuntime } from '../bootstrap';

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
