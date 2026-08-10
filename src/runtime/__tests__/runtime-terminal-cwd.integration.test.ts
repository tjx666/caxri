import { mkdir, mkdtemp, rename, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { IPty, spawn as spawnPty } from 'node-pty';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { RuntimeEvent } from '../../shared/ipc';
import { StructuredLogger } from '../../shared/node/logger';
import { createRuntime } from '../bootstrap';

const temporaryDirectories: string[] = [];

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

describe('Runtime Terminal cwd authorization', () => {
    it('rejects a requested cwd replaced after authorization but before spawn', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-runtime-cwd-race-'));
        temporaryDirectories.push(directory);
        const projectRoot = join(directory, 'project');
        const projectFolder = join(projectRoot, 'folder');
        const outside = join(directory, 'outside');
        await Promise.all([mkdir(projectFolder, { recursive: true }), mkdir(outside)]);
        let swapOnResolve = false;
        const spawn = vi.fn<typeof spawnPty>(() => createFakePty());
        const runtime = await createRuntime({
            userDataPath: join(directory, 'user-data'),
            logger: new StructuredLogger(join(directory, 'logs')),
            send: () => undefined,
            terminal: {
                resolveExecutable: async () => {
                    if (swapOnResolve) {
                        swapOnResolve = false;
                        await rename(projectFolder, `${projectFolder}-original`);
                        await symlink(outside, projectFolder);
                    }
                    return '/bin/zsh';
                },
                spawn,
            },
        });

        try {
            const project = await runtime.handlers['project.create']({ rootPath: projectRoot });
            const created = await runtime.handlers['session.create']({
                projectId: project.id,
                defaultAgent: 'shell',
            });
            expect(spawn).toHaveBeenCalledTimes(1);
            swapOnResolve = true;

            const terminal = await runtime.handlers['terminal.create']({
                sessionId: created.session.id,
                kind: 'shell',
                cwd: projectFolder,
            });

            expect(terminal.lastProcessState).toBe('failed');
            expect(spawn).toHaveBeenCalledTimes(1);
        } finally {
            await runtime.close();
        }
    });

    it('revalidates a recorded cwd before restarting it', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-runtime-restart-cwd-race-'));
        temporaryDirectories.push(directory);
        const projectRoot = join(directory, 'project');
        const projectFolder = join(projectRoot, 'folder');
        const outside = join(directory, 'outside');
        await Promise.all([
            mkdir(projectFolder, { recursive: true }),
            mkdir(join(outside, 'folder'), { recursive: true }),
        ]);
        let swapOnResolve = false;
        const spawn = vi.fn<typeof spawnPty>(() => createFakePty());
        const runtime = await createRuntime({
            userDataPath: join(directory, 'user-data'),
            logger: new StructuredLogger(join(directory, 'logs')),
            send: () => undefined,
            terminal: {
                resolveExecutable: async () => {
                    if (swapOnResolve) {
                        swapOnResolve = false;
                        await rename(projectRoot, `${projectRoot}-original`);
                        await symlink(outside, projectRoot);
                    }
                    return '/bin/zsh';
                },
                spawn,
            },
        });

        try {
            const project = await runtime.handlers['project.create']({ rootPath: projectRoot });
            const created = await runtime.handlers['session.create']({
                projectId: project.id,
                defaultAgent: 'shell',
            });
            const terminal = await runtime.handlers['terminal.create']({
                sessionId: created.session.id,
                kind: 'shell',
                cwd: projectFolder,
            });
            expect(spawn).toHaveBeenCalledTimes(2);
            swapOnResolve = true;

            await expect(
                runtime.handlers['terminal.restart']({ terminalId: terminal.id }),
            ).rejects.toMatchObject({ code: 'CONFLICT' });
            expect(spawn).toHaveBeenCalledTimes(2);
        } finally {
            await runtime.close();
        }
    });

    it('rejects a recorded cwd retargeted before restart begins', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-runtime-restart-cwd-retargeted-'));
        temporaryDirectories.push(directory);
        const projectRoot = join(directory, 'project');
        const projectFolder = join(projectRoot, 'folder');
        const outside = join(directory, 'outside');
        await Promise.all([
            mkdir(projectFolder, { recursive: true }),
            mkdir(join(outside, 'folder'), { recursive: true }),
        ]);
        const spawn = vi.fn<typeof spawnPty>(() => createFakePty());
        const runtime = await createRuntime({
            userDataPath: join(directory, 'user-data'),
            logger: new StructuredLogger(join(directory, 'logs')),
            send: () => undefined,
            terminal: { resolveExecutable: () => Promise.resolve('/bin/zsh'), spawn },
        });

        try {
            const project = await runtime.handlers['project.create']({ rootPath: projectRoot });
            const created = await runtime.handlers['session.create']({
                projectId: project.id,
                defaultAgent: 'shell',
            });
            const terminal = await runtime.handlers['terminal.create']({
                sessionId: created.session.id,
                kind: 'shell',
                cwd: projectFolder,
            });
            expect(spawn).toHaveBeenCalledTimes(2);
            await rename(projectRoot, `${projectRoot}-original`);
            await symlink(outside, projectRoot);

            await expect(
                runtime.handlers['terminal.restart']({ terminalId: terminal.id }),
            ).rejects.toMatchObject({ code: 'CONFLICT' });
            expect(spawn).toHaveBeenCalledTimes(2);
        } finally {
            await runtime.close();
        }
    });

    it('marks an interrupted Terminal failed when restore cwd validation rejects', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-runtime-restore-cwd-rejected-'));
        temporaryDirectories.push(directory);
        const userDataPath = join(directory, 'user-data');
        const projectRoot = join(directory, 'project');
        const projectFolder = join(projectRoot, 'folder');
        const outside = join(directory, 'outside');
        await Promise.all([mkdir(projectFolder, { recursive: true }), mkdir(outside)]);
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
        const terminal = await runtimeA.handlers['terminal.create']({
            sessionId: created.session.id,
            kind: 'shell',
            cwd: projectFolder,
        });
        await runtimeA.close();
        await rename(projectFolder, `${projectFolder}-original`);
        await symlink(outside, projectFolder);

        const runtimeB = await createRuntime({
            userDataPath,
            logger: new StructuredLogger(join(directory, 'logs-b')),
            send: () => undefined,
            terminal: {
                resolveExecutable: () => Promise.resolve('/bin/zsh'),
                spawn: () => createFakePty(),
            },
        });
        try {
            await vi.waitFor(async () => {
                const state = await runtimeB.handlers['app.bootstrap']({});
                expect(
                    state.terminals.find((candidate) => candidate.id === terminal.id)
                        ?.lastProcessState,
                ).toBe('failed');
            });
        } finally {
            await runtimeB.close();
        }
    });

    it('emits the failed Terminal record when restore cwd changes during launch', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-runtime-restore-cwd-event-'));
        temporaryDirectories.push(directory);
        const userDataPath = join(directory, 'user-data');
        const projectRoot = join(directory, 'project');
        const projectFolder = join(projectRoot, 'folder');
        const outside = join(directory, 'outside');
        await Promise.all([mkdir(projectFolder, { recursive: true }), mkdir(outside)]);
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
        const terminal = await runtimeA.handlers['terminal.create']({
            sessionId: created.session.id,
            kind: 'shell',
            cwd: projectFolder,
        });
        await runtimeA.handlers['terminal.close']({ terminalId: created.terminal.id });
        await runtimeA.close();

        const events: RuntimeEvent[] = [];
        const runtimeB = await createRuntime({
            userDataPath,
            logger: new StructuredLogger(join(directory, 'logs-b')),
            send: (event) => events.push(event),
            terminal: {
                resolveExecutable: async () => {
                    await rename(projectFolder, `${projectFolder}-original`);
                    await symlink(outside, projectFolder);
                    return '/bin/zsh';
                },
                spawn: () => createFakePty(),
            },
        });
        try {
            await vi.waitFor(async () => {
                const state = await runtimeB.handlers['app.bootstrap']({});
                expect(
                    state.terminals.find((candidate) => candidate.id === terminal.id)
                        ?.lastProcessState,
                ).toBe('failed');
            });
            expect(events).toContainEqual({
                event: 'state.changed',
                payload: { kind: 'records', sessionIds: [], terminalIds: [terminal.id] },
            });
        } finally {
            await runtimeB.close();
        }
    });
});
