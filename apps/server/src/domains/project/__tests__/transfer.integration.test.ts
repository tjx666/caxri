import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, onTestFinished, vi } from 'vitest';

import { chatStateStore } from '../../agent-chat';
import { CaxriDatabase } from '../../db';
import {
    exportProjectTransfer,
    importProjectTransferFile,
    parseProjectTransfer,
    writeProjectTransfer,
} from '../transfer';

async function fixture() {
    const scratch = await mkdtemp(join(tmpdir(), 'caxri-project-transfer-'));
    const directory = await realpath(scratch);
    const databases: CaxriDatabase[] = [];
    onTestFinished(async () => {
        for (const database of databases) database.close();
        await rm(directory, { recursive: true, force: true });
    });
    const open = (name: string) => {
        const database = new CaxriDatabase(join(directory, `${name}.db`));
        databases.push(database);
        return database;
    };
    const folder = async (name: string) => {
        const path = join(directory, name);
        await mkdir(path, { recursive: true });
        return path;
    };
    return { directory, folder, open };
}

/**
 * The source machine: one Project with a pinned manual Session holding an Agent conversation, an automatically named
 * Session that works in a linked worktree, and an archived Session; plus a hidden Project and one whose folder will be
 * gone by the time the file is imported.
 */
async function seedSource(context: Awaited<ReturnType<typeof fixture>>) {
    const source = context.open('source');
    const app = await context.folder('app');
    const worktree = await context.folder('app-feature');
    const gone = await context.folder('gone');
    const hidden = await context.folder('hidden');

    const project = source.createProject(app);
    const archived = source.createSession(project.id, null).session;
    source.archiveSession(archived.id);
    const inWorktree = source.createSession(project.id, null, undefined, {
        title: 'Feature branch',
    }).session;
    const worktreeProject = source.createProject(worktree, project.id);
    source.selectWorkbenchProject(inWorktree.id, worktreeProject.id);
    const pinned = source.createSession(project.id, null).session;
    source.renameSession(pinned.id, 'Fix login');
    source.setSessionPinned(pinned.id, true);
    const agent = source.createTerminal(pinned.id, 'claude', join(app, 'packages'), 'chat');
    source.rebindAgentSession(agent.id, 'claude', 'conversation-1');
    chatStateStore(source).setResumeAt(agent.id, 'record-9');
    source.createTerminal(pinned.id, 'shell', app);

    source.createSession(source.createProject(gone).id, null);
    source.hideProject(source.createProject(hidden).id);
    return { app, gone, source, worktree };
}

describe('Project transfer', () => {
    it('exports visible Projects with their unarchived Sessions and resumable Agent Terminals', async () => {
        const context = await fixture();
        const { app, gone, source, worktree } = await seedSource(context);

        const document = exportProjectTransfer(source, chatStateStore(source), 1_000);

        expect(document).toEqual({
            format: 'caxri.projects',
            formatVersion: 1,
            exportedAt: 1_000,
            projects: [
                {
                    rootPath: app,
                    sessions: [
                        {
                            title: 'Fix login',
                            titleMode: 'manual',
                            pinned: true,
                            terminals: [
                                {
                                    provider: 'claude',
                                    surface: 'chat',
                                    cwd: join(app, 'packages'),
                                    agentSessionId: 'conversation-1',
                                    resumeAt: 'record-9',
                                },
                            ],
                        },
                        {
                            title: 'Feature branch',
                            titleMode: 'automatic',
                            pinned: false,
                            workbenchRootPath: worktree,
                            terminals: [],
                        },
                    ],
                },
                {
                    rootPath: gone,
                    sessions: [expect.objectContaining({ pinned: false, terminals: [] })],
                },
            ],
        });
    });

    it('recreates the exported Sessions on another database and never duplicates them', async () => {
        const context = await fixture();
        const { app, gone, source, worktree } = await seedSource(context);
        const file = join(context.directory, 'export.json');
        await expect(writeProjectTransfer(source, file)).resolves.toEqual({
            path: file,
            projectCount: 2,
            sessionCount: 3,
        });
        await rm(gone, { recursive: true });
        const target = context.open('target');
        const emit = vi.fn();

        await expect(importProjectTransferFile(target, file, emit)).resolves.toEqual({
            projectCount: 1,
            sessionCount: 2,
            skipped: [{ rootPath: gone, reason: 'missing' }],
            missingWorkbenchRoots: [],
        });

        const [project] = target.listVisibleProjects();
        expect(project.rootPath).toBe(app);
        const sessions = target
            .listSessions(project.id)
            .toSorted((left, right) => left.sidebarOrder - right.sidebarOrder);
        expect(
            sessions.map(({ title, titleMode, pinnedAt, rootPath }) => ({
                title,
                titleMode,
                isPinned: pinnedAt !== undefined,
                rootPath,
            })),
        ).toEqual([
            { title: 'Fix login', titleMode: 'manual', isPinned: true, rootPath: app },
            {
                title: 'Feature branch',
                titleMode: 'automatic',
                isPinned: false,
                rootPath: worktree,
            },
        ]);
        const [terminal] = target.listTerminals(sessions[0].id);
        expect(terminal).toMatchObject({
            kind: 'claude',
            surface: 'chat',
            cwd: join(app, 'packages'),
            agentSessionId: 'conversation-1',
            lastProcessState: 'detached',
            lastAgentProcessState: 'detached',
        });
        expect(chatStateStore(target).resumeAt(terminal.id)).toBe('record-9');
        expect(emit).toHaveBeenCalledWith({
            event: 'state.changed',
            payload: { kind: 'full', reason: 'project.import' },
        });

        await expect(importProjectTransferFile(target, file, emit)).resolves.toMatchObject({
            projectCount: 0,
            sessionCount: 0,
            skipped: [
                { rootPath: app, reason: 'exists' },
                { rootPath: gone, reason: 'missing' },
            ],
        });
        expect(target.listSessions(project.id)).toHaveLength(2);
    });

    it('opens a Session whose worktree is gone in its Project root and resumes Agents there, never outside it', async () => {
        const context = await fixture();
        const app = await context.folder('app');
        const worktree = join(context.directory, 'removed-worktree');
        const file = join(context.directory, 'export.json');
        await writeFile(
            file,
            JSON.stringify({
                format: 'caxri.projects',
                formatVersion: 1,
                exportedAt: 1,
                projects: [
                    {
                        rootPath: app,
                        sessions: [
                            {
                                title: 'Old branch',
                                titleMode: 'manual',
                                pinned: false,
                                workbenchRootPath: worktree,
                                terminals: [
                                    {
                                        provider: 'codex',
                                        surface: 'pty',
                                        cwd: worktree,
                                        agentSessionId: 'thread-1',
                                    },
                                    {
                                        provider: 'claude',
                                        surface: 'chat',
                                        cwd: join(app, '..', 'elsewhere'),
                                        agentSessionId: 'conversation-2',
                                    },
                                ],
                            },
                        ],
                    },
                ],
            }),
        );
        const target = context.open('target');

        await expect(importProjectTransferFile(target, file, vi.fn())).resolves.toMatchObject({
            sessionCount: 1,
            missingWorkbenchRoots: [worktree],
        });
        const [session] = target.listSessions();
        expect(session.rootPath).toBe(app);
        expect(target.listTerminals(session.id)).toEqual([
            expect.objectContaining({ kind: 'codex', cwd: app, agentSessionId: 'thread-1' }),
            expect.objectContaining({ kind: 'claude', cwd: app, agentSessionId: 'conversation-2' }),
        ]);
    });

    it('removes a partly imported Project so importing the file again brings in every Session', async () => {
        const context = await fixture();
        const { app, gone, source } = await seedSource(context);
        const file = join(context.directory, 'export.json');
        await writeProjectTransfer(source, file);
        await rm(gone, { recursive: true });
        const target = context.open('target');
        const createSession = target.createSession.bind(target);
        const failSecond = vi
            .spyOn(target, 'createSession')
            .mockImplementationOnce(createSession)
            .mockImplementationOnce(() => {
                throw new Error('disk full');
            });

        await expect(importProjectTransferFile(target, file, vi.fn())).rejects.toThrow('disk full');
        expect(target.findProjectByRootPath(app)).toBeUndefined();
        expect(target.listSessions()).toEqual([]);

        failSecond.mockRestore();
        await expect(importProjectTransferFile(target, file, vi.fn())).resolves.toMatchObject({
            projectCount: 1,
            sessionCount: 2,
        });
        expect(
            target
                .listSessions()
                .map(({ title }) => title)
                .toSorted((left, right) => left.localeCompare(right)),
        ).toEqual(['Feature branch', 'Fix login']);
    });

    it('brings back a Project the user removed with its earlier Sessions instead of copies from the file', async () => {
        const context = await fixture();
        const { app, gone, source } = await seedSource(context);
        const file = join(context.directory, 'export.json');
        await writeProjectTransfer(source, file);
        await rm(gone, { recursive: true });
        const target = context.open('target');
        const project = target.createProject(app);
        const earlier = target.createSession(project.id, null).session;
        target.hideProject(project.id);
        const emit = vi.fn();

        await expect(importProjectTransferFile(target, file, emit)).resolves.toMatchObject({
            projectCount: 0,
            sessionCount: 0,
            skipped: [
                { rootPath: app, reason: 'restored' },
                { rootPath: gone, reason: 'missing' },
            ],
        });
        expect(target.listVisibleProjects().map(({ id }) => id)).toEqual([project.id]);
        expect(target.listSessions(project.id).map(({ id }) => id)).toEqual([earlier.id]);
        expect(emit).toHaveBeenCalledWith({
            event: 'state.changed',
            payload: { kind: 'full', reason: 'project.import' },
        });
    });

    it('imports into a removed Project that has no Session left to bring back', async () => {
        const context = await fixture();
        const { app, gone, source } = await seedSource(context);
        const file = join(context.directory, 'export.json');
        await writeProjectTransfer(source, file);
        await rm(gone, { recursive: true });
        const target = context.open('target');
        const project = target.createProject(app);
        target.archiveSession(target.createSession(project.id, null).session.id);
        target.hideProject(project.id);

        await expect(importProjectTransferFile(target, file, vi.fn())).resolves.toMatchObject({
            projectCount: 1,
            sessionCount: 2,
        });
        expect(target.listVisibleProjects().map(({ id }) => id)).toContain(project.id);
    });

    it('rejects a file that is not a Projects and Sessions export', async () => {
        const context = await fixture();
        const file = join(context.directory, 'theme.json');
        await writeFile(file, JSON.stringify({ name: 'A theme' }));

        expect(() => parseProjectTransfer('not json')).toThrow('not a Caxri Projects');
        await expect(
            importProjectTransferFile(context.open('target'), file, vi.fn()),
        ).rejects.toThrow('not a Caxri Projects');
        expect(await readFile(file, 'utf8')).toContain('A theme');
    });
});
