import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { clearExecutableCache } from '../../../discovery';
import type * as ProcessDetection from '../../../process-detection';
import { AgentService, createLocalAgentAdapters } from '../../../service';

const { detectForegroundAgentOpenFiles } = vi.hoisted(() => ({
    detectForegroundAgentOpenFiles: vi.fn<() => Promise<ProcessDetection.ProcessOpenFile[]>>(),
}));

vi.mock('../../../process-detection', async (importOriginal) => ({
    ...(await importOriginal<typeof ProcessDetection>()),
    detectForegroundAgentOpenFiles,
}));

const temporaryDirectories: string[] = [];

interface CodexFixture {
    root: string;
    service: AgentService;
    startedAt: number;
    siblingThreadId: string;
}

/**
 * One Project root, one sibling Codex thread created after the Terminal under test started, and a Codex executable on
 * `PATH`. That thread is exactly the bait the heuristic used to take.
 */
async function createIdleTerminalFixture(): Promise<CodexFixture> {
    const directory = await mkdtemp(join(tmpdir(), 'caxri-codex-idle-'));
    temporaryDirectories.push(directory);
    const root = join(directory, 'project');
    const state = join(directory, 'codex-state');
    const bin = join(directory, 'bin');
    const sessions = join(directory, 'codex-home', 'sessions');
    await Promise.all([
        mkdir(root),
        mkdir(state),
        mkdir(bin),
        mkdir(sessions, { recursive: true }),
    ]);
    const executable = join(bin, 'codex');
    await writeFile(executable, '#!/bin/sh\nprintf "codex 1.0\\n"\n', 'utf8');
    await chmod(executable, 0o700);
    const startedAt = Date.now();
    const siblingThreadId = '01a08fbe-2b76-7ae2-8c0e-8a11262ac36d';
    const database = new Database(join(state, 'state_9.sqlite'));
    database.exec(
        'CREATE TABLE threads (id TEXT PRIMARY KEY, cwd TEXT, title TEXT, name TEXT, created_at_ms INTEGER, updated_at_ms INTEGER, tokens_used INTEGER, archived INTEGER)',
    );
    database
        .prepare('INSERT INTO threads VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(
            siblingThreadId,
            root,
            'https://linear.app/example/issue/TASK-24682 handle this',
            'handle TASK-24682',
            startedAt + 360_000,
            startedAt + 360_000,
            1200,
            0,
        );
    database.close();
    vi.stubEnv('PATH', bin);
    vi.stubEnv('SHELL', '/usr/bin/false');
    const service = new AgentService(
        undefined,
        createLocalAgentAdapters({
            homeDirectory: directory,
            variables: {
                CLAUDE_CONFIG_DIR: join(directory, 'missing'),
                CODEX_HOME: join(directory, 'codex-home'),
                CODEX_SQLITE_HOME: state,
            },
        }),
    );
    return { root, service, startedAt, siblingThreadId };
}

describe('Codex idle Terminal binding', () => {
    beforeEach(() => {
        clearExecutableCache();
        detectForegroundAgentOpenFiles.mockReset();
    });

    afterEach(async () => {
        vi.unstubAllEnvs();
        clearExecutableCache();
        const pendingCleanup = [...temporaryDirectories];
        temporaryDirectories.length = 0;
        await Promise.all(pendingCleanup.map((path) => rm(path, { recursive: true, force: true })));
    });

    it('reports no identity for a Codex process that holds no rollout open', async () => {
        const { root, service, startedAt } = await createIdleTerminalFixture();
        /**
         * A live Codex always has files open; none of them is a rollout until its first message creates a thread.
         */
        detectForegroundAgentOpenFiles.mockResolvedValue([
            { access: 'r', path: '/usr/lib/dyld', pid: 4242 },
            { access: 'u', path: join(root, '.git', 'index'), pid: 4242 },
        ]);

        await expect(
            service.snapshot('codex', {
                rootPath: root,
                processState: 'running',
                shellPid: 4242,
                startedAt,
            }),
        ).resolves.toMatchObject({ sessionId: undefined, title: undefined });
    });

    it('still falls back to discovery when the open-file probe is unusable', async () => {
        const { root, service, startedAt, siblingThreadId } = await createIdleTerminalFixture();
        /**
         * An empty list means `ps`/`lsof` failed closed, which is not evidence about the Agent's threads.
         */
        detectForegroundAgentOpenFiles.mockResolvedValue([]);

        await expect(
            service.snapshot('codex', {
                rootPath: root,
                processState: 'running',
                shellPid: 4242,
                startedAt,
            }),
        ).resolves.toMatchObject({ sessionId: siblingThreadId });
    });
});
