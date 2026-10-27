import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { basename, join } from 'node:path';

import type { ServerEvent } from '@caxri/protocol';
import { listPaneTerminalIds } from '@caxri/protocol';
import { StructuredLogger } from '@caxri/system';
import type { spawn as spawnPty } from 'node-pty';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createTestDomainServices } from '../../__tests__/support/domain-services';
import { LocalTerminalExecution } from '../../__tests__/support/local-terminal-execution';
import { CaxriDatabase } from '../db/repository';
import { GitService } from '../git';
import { ProjectStatusService } from '../project-status';
import { createFakePty, createPendingAgentAdapters } from './create-test-domain-services';

const temporaryDirectories: string[] = [];

afterEach(async () => {
    const pendingDirectories = temporaryDirectories.slice();
    temporaryDirectories.length = 0;
    await Promise.all(pendingDirectories.map((path) => rm(path, { recursive: true, force: true })));
    vi.restoreAllMocks();
});

describe('domain-service composition root', () => {
    it('applies provider settings through domain composition to a new Agent Terminal', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-runtime-agent-settings-'));
        temporaryDirectories.push(directory);
        const projectRoot = join(directory, 'project');
        await mkdir(projectRoot);
        const spawn = vi.fn<typeof spawnPty>(() => createFakePty());
        const start = vi.spyOn(LocalTerminalExecution.prototype, 'start');
        const runtime = await createTestDomainServices({
            userDataPath: join(directory, 'user-data'),
            logger: new StructuredLogger(join(directory, 'logs')),
            send: () => {},
            terminal: {
                agentEnvironment: () =>
                    Promise.resolve({ HOME: directory, PATH: '/login/bin:/usr/bin' }),
                spawn,
            },
            agentAdapters: createPendingAgentAdapters(),
        });

        try {
            expect(await runtime.handlers['agentHooks.get']({})).toMatchObject({
                claude: { kind: 'notInstalled' },
                codex: { kind: 'notInstalled' },
            });
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
            expect(['/bin/bash', '/bin/zsh']).toContain(spawn.mock.calls[0]?.[0]);
            expect(spawn.mock.calls[0]?.[2]).toMatchObject({ cwd: canonicalProjectRoot });
            const agent = start.mock.calls[0]?.[0].agent;
            expect(agent?.executable).toBe('/bin/echo');
            expect(agent?.args).toEqual(['-c', 'tui.auto_recap=false', '--profile', 'focused']);
            expect(agent?.environment).toMatchObject({ PATH: '/login/bin:/usr/bin' });
        } finally {
            await runtime.close();
        }
    });

    it('applies the configured cwd only to new Terminals and preserves recorded cwd on restart', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-runtime-cwd-'));
        const homeDirectory = await mkdtemp(join(homedir(), '.caxri-runtime-cwd-'));
        temporaryDirectories.push(directory, homeDirectory);
        const projectRoot = join(directory, 'project');
        const projectFolder = join(projectRoot, 'folder');
        const projectFile = join(projectRoot, 'file.txt');
        const customRoot = join(directory, 'custom');
        const changedRoot = join(directory, 'changed');
        await mkdir(projectRoot);
        await Promise.all([
            mkdir(customRoot),
            mkdir(changedRoot),
            mkdir(projectFolder),
            writeFile(projectFile, 'file', 'utf8'),
        ]);
        await symlink(customRoot, join(projectRoot, 'outside-link'));
        const spawn = vi.fn<typeof spawnPty>(() => createFakePty());
        const runtime = await createTestDomainServices({
            userDataPath: join(directory, 'user-data'),
            logger: new StructuredLogger(join(directory, 'logs')),
            send: () => {},
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
            expect(original.terminal!.cwd).toBe(project.rootPath);

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
            expect(customized.terminal!.cwd).toBe(canonicalCustomRoot);
            expect(additional.cwd).toBe(canonicalCustomRoot);

            const projectLocal = await runtime.handlers['terminal.create']({
                sessionId: customized.session.id,
                kind: 'shell',
                cwd: projectFolder,
            });
            expect(projectLocal.cwd).toBe(await realpath(projectFolder));
            await expect(
                runtime.handlers['terminal.create']({
                    sessionId: customized.session.id,
                    kind: 'shell',
                    cwd: customRoot,
                }),
            ).rejects.toMatchObject({ code: 'PATH_DENIED' });
            await expect(
                runtime.handlers['terminal.create']({
                    sessionId: customized.session.id,
                    kind: 'shell',
                    cwd: join(projectRoot, 'outside-link'),
                }),
            ).rejects.toMatchObject({ code: 'PATH_DENIED' });
            await expect(
                runtime.handlers['terminal.create']({
                    sessionId: customized.session.id,
                    kind: 'shell',
                    cwd: projectFile,
                }),
            ).rejects.toMatchObject({ code: 'VALIDATION' });

            await runtime.handlers['settings.update']({
                source: JSON.stringify({
                    ...currentSettings.value,
                    'terminal.defaultWorkingDirectory': changedRoot,
                }),
            });
            await runtime.handlers['terminal.restart']({
                terminalId: additional.id,
                mode: 'resume',
            });
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

    it('serves a Project, Session, and Files workflow through the handler table', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-runtime-'));
        temporaryDirectories.push(directory);
        const projectRoot = join(directory, 'project');
        await mkdir(projectRoot);
        await writeFile(join(projectRoot, 'README.md'), '# Caxri\n', 'utf8');
        const events: ServerEvent[] = [];
        const runtime = await createTestDomainServices({
            userDataPath: join(directory, 'user-data'),
            logger: new StructuredLogger(join(directory, 'logs')),
            send: (event) => {
                events.push(event);
            },
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
            expect(project).toMatchObject({ title: 'project' });
            const created = await handlers['session.create']({
                projectId: project.id,
                defaultAgent: 'shell',
            });
            expect(created.session.projectId).toBe(project.id);
            expect(created.terminal!.lastProcessState).toBe('running');

            const entries = await handlers['files.list']({ sessionId: created.session.id });
            expect(entries.entries.map((entry) => entry.name)).toContain('README.md');
            expect(entries.truncated).toBe(false);
            const document = await handlers['files.read']({
                sessionId: created.session.id,
                path: join(project.rootPath, 'README.md'),
            });
            expect(document.content).toBe('# Caxri\n');

            const populated = await handlers['app.bootstrap']({});
            expect(populated.projects).toHaveLength(1);
            expect(populated.sessions).toHaveLength(1);
            expect(populated.selectedSessionId).toBe(created.session.id);
            /**
             * Live PTY identity is Server state, not durable metadata, so it must come from the manager.
             */
            expect(populated.terminals[0]).toMatchObject({
                id: created.terminal!.id,
                processId: 4242,
            });
            expect(await handlers['terminal.runningCount']({})).toEqual({ terminals: 1, chats: 0 });
            expect(
                await handlers['app.records']({
                    sessionIds: [created.session.id],
                    terminalIds: [created.terminal!.id],
                }),
            ).toMatchObject({
                sessions: [{ id: created.session.id }],
                terminals: [{ id: created.terminal!.id, processId: 4242 }],
            });

            const remaining = await handlers['session.delete']({ sessionId: created.session.id });
            /**
             * Session deletion removes Session metadata only; the Project keeps its durable root.
             */
            expect(remaining).toMatchObject({
                sessions: [],
                terminals: [],
                projects: [{ id: project.id, rootPath: project.rootPath }],
            });
            expect(await handlers['terminal.runningCount']({})).toEqual({ terminals: 0, chats: 0 });

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
                    terminalIds: [created.terminal!.id, 'missing-terminal'],
                }),
            ).toEqual({ sessions: [], terminals: [] });
        } finally {
            await runtime.close();
        }
    });

    it('reports a missing Session as NOT_FOUND and keeps the Runtime usable', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-runtime-errors-'));
        temporaryDirectories.push(directory);
        const runtime = await createTestDomainServices({
            userDataPath: join(directory, 'user-data'),
            logger: new StructuredLogger(join(directory, 'logs')),
            send: () => {},
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
        const runtime = await createTestDomainServices({
            userDataPath: join(directory, 'user-data'),
            logger: new StructuredLogger(join(directory, 'logs')),
            send: () => {},
        });

        await expect(runtime.close()).resolves.toBeUndefined();
        await expect(runtime.close()).resolves.toBeUndefined();
    });

    it('evicts Git and Project Status caches when Sessions, Projects, or the Runtime are removed', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-runtime-git-cache-'));
        temporaryDirectories.push(directory);
        const userDataPath = join(directory, 'user-data');
        const firstRoot = join(directory, 'first');
        const secondRoot = join(directory, 'second');
        await Promise.all([mkdir(firstRoot), mkdir(secondRoot)]);
        const evict = vi.spyOn(GitService.prototype, 'evictSessions');
        const evictStatus = vi.spyOn(ProjectStatusService.prototype, 'evictSessions');
        const clear = vi.spyOn(GitService.prototype, 'close');
        const runtime = await createTestDomainServices({
            userDataPath,
            logger: new StructuredLogger(join(directory, 'logs')),
            send: () => {},
            terminal: { spawn: () => createFakePty() },
        });

        try {
            const firstProject = await runtime.handlers['project.create']({ rootPath: firstRoot });
            const secondProject = await runtime.handlers['project.create']({
                rootPath: secondRoot,
            });
            const firstSession = await runtime.handlers['session.create']({
                projectId: firstProject.id,
                defaultAgent: 'shell',
            });
            const secondSession = await runtime.handlers['session.create']({
                projectId: secondProject.id,
                defaultAgent: 'shell',
            });
            const direct = new CaxriDatabase(join(userDataPath, 'caxri.db'));
            direct.selectWorkbenchProject(secondSession.session.id, firstProject.id);
            direct.close();

            await runtime.handlers['project.delete']({ projectId: firstProject.id });
            expect(evict).toHaveBeenCalledWith(
                expect.arrayContaining([firstSession.session.id, secondSession.session.id]),
            );
            expect(evictStatus).toHaveBeenCalledWith(
                expect.arrayContaining([firstSession.session.id, secondSession.session.id]),
            );

            const thirdSession = await runtime.handlers['session.create']({
                projectId: secondProject.id,
                defaultAgent: 'shell',
            });
            await runtime.handlers['session.deleteMany']({
                sessionIds: [secondSession.session.id, thirdSession.session.id],
            });
            expect(evict).toHaveBeenLastCalledWith([
                secondSession.session.id,
                thirdSession.session.id,
            ]);
            expect(evictStatus).toHaveBeenLastCalledWith([
                secondSession.session.id,
                thirdSession.session.id,
            ]);
            expect((await runtime.handlers['app.bootstrap']({})).sessions).toHaveLength(0);
            await runtime.close();
            expect(clear).toHaveBeenCalledOnce();
        } finally {
            await runtime.close();
            evict.mockRestore();
            evictStatus.mockRestore();
            clear.mockRestore();
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

        const domainsA = await createTestDomainServices({
            userDataPath,
            logger: new StructuredLogger(join(directory, 'logs-a')),
            send: () => {},
            terminal: {
                resolveExecutable: () => Promise.resolve('/usr/local/bin/claude'),
                spawn: () => createFakePty(),
            },
            agentAdapters: createPendingAgentAdapters(),
        });
        const project = await domainsA.handlers['project.create']({ rootPath: projectRoot });
        const first = await domainsA.handlers['session.create']({
            projectId: project.id,
            defaultAgent: 'claude',
        });
        const selected = await domainsA.handlers['session.create']({
            projectId: project.id,
            defaultAgent: 'claude',
        });
        await domainsA.handlers['terminal.terminateAll']({});
        await domainsA.close();

        const snapshot = vi.fn((context: { correlationId?: string }) =>
            Promise.resolve({
                provider: 'claude' as const,
                status: 'completed' as const,
                observedAt: Date.now(),
                available: true,
                sessionId: context.correlationId,
            }),
        );
        const domainsB = await createTestDomainServices({
            userDataPath,
            logger: new StructuredLogger(join(directory, 'logs-b')),
            send: () => {},
            agentAdapters: createPendingAgentAdapters({
                claude: { provider: 'claude', snapshot },
            }),
        });

        try {
            await vi.waitFor(() => expect(snapshot).toHaveBeenCalledTimes(1));
            expect(snapshot.mock.calls[0]?.[0].correlationId).toBe(selected.terminal!.id);

            await domainsB.handlers['session.select']({ sessionId: first.session.id });
            await vi.waitFor(() => expect(snapshot).toHaveBeenCalledTimes(2));
            expect(snapshot.mock.calls[1]?.[0].correlationId).toBe(first.terminal!.id);
        } finally {
            await domainsB.close();
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
        const domainsA = await createTestDomainServices({
            userDataPath,
            logger: new StructuredLogger(join(directory, 'logs-a')),
            send: () => {},
            terminal: {
                resolveExecutable: () => Promise.resolve('/bin/zsh'),
                spawn: () => createFakePty(),
            },
        });
        const project = await domainsA.handlers['project.create']({ rootPath: projectRoot });
        const created = await domainsA.handlers['session.create']({
            projectId: project.id,
            defaultAgent: 'shell',
        });
        await domainsA.close();

        const direct = new CaxriDatabase(join(userDataPath, 'caxri.db'));
        direct.database
            .prepare('UPDATE session_views SET roots_json = ? WHERE session_id = ?')
            .run('{', created.session.id);
        direct.close();

        const logger = new StructuredLogger(join(directory, 'logs-b'));
        const domainsB = await createTestDomainServices({ userDataPath, logger, send: () => {} });
        try {
            const bootstrap = await domainsB.handlers['app.bootstrap']({});
            const repaired = bootstrap.sessionStates.find(
                (state) => state.sessionId === created.session.id,
            );
            expect(repaired).toMatchObject({
                desiredSecondarySidebarViewContainerId: 'caxri.files',
            });
            expect(repaired && listPaneTerminalIds(repaired.paneLayout)).toEqual([
                created.terminal!.id,
            ]);

            await logger.flush();
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
            await domainsB.close();
        }
    });
});
