import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';

import { clearExecutableCache } from '../../../discovery';
import { AgentService, createLocalAgentAdapters } from '../../../service';

const temporaryDirectories: string[] = [];

afterEach(async () => {
    clearExecutableCache();
    vi.unstubAllEnvs();
    await Promise.all(
        temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
    );
});

describe('Codex provider', () => {
    it('capability-detects the Codex thread index and exposes bounded metadata', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-agent-codex-state-'));
        temporaryDirectories.push(directory);
        const root = join(directory, 'project');
        const state = join(directory, 'codex-state');
        const bin = join(directory, 'bin');
        await Promise.all([mkdir(root), mkdir(state), mkdir(bin)]);
        const executable = join(bin, 'codex');
        await writeFile(executable, '#!/bin/sh\nprintf "codex 1.0\\n"\n', 'utf8');
        await chmod(executable, 0o700);
        const startedAt = Date.now();
        const database = new Database(join(state, 'state_9.sqlite'));
        database.exec(
            'CREATE TABLE threads (id TEXT PRIMARY KEY, cwd TEXT, title TEXT, name TEXT, created_at_ms INTEGER, updated_at_ms INTEGER, tokens_used INTEGER, archived INTEGER)',
        );
        database
            .prepare('INSERT INTO threads VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
            .run(
                'codex-session-older',
                root,
                '$debug https://github.com/example/project/issues/1',
                null,
                startedAt - 60_000,
                startedAt - 60_000,
                42,
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
                    CODEX_HOME: join(directory, 'missing-codex-home'),
                    CODEX_SQLITE_HOME: state,
                },
            }),
        );

        await expect(
            service.snapshot('codex', { rootPath: root, processState: 'running', startedAt }),
        ).resolves.toMatchObject({
            available: true,
            status: 'running',
            sessionId: undefined,
            title: undefined,
        });

        const writableDatabase = new Database(join(state, 'state_9.sqlite'));
        writableDatabase
            .prepare('INSERT INTO threads VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
            .run(
                'codex-session-1',
                root,
                'Raw first prompt',
                'Finish Phase 1',
                startedAt + 1,
                startedAt + 1,
                12_345,
                0,
            );
        writableDatabase
            .prepare('INSERT INTO threads VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
            .run(
                'codex-session-2',
                root,
                'Second prompt',
                'Keep this Terminal',
                startedAt + 2,
                startedAt + 2,
                24,
                0,
            );
        writableDatabase.close();

        await expect(
            service.snapshot('codex', { rootPath: root, processState: 'running', startedAt }),
        ).resolves.toMatchObject({
            available: true,
            sessionId: 'codex-session-1',
            status: 'running',
            title: 'Finish Phase 1',
            usage: [{ label: 'Tokens', value: '12,345' }],
            version: 'codex 1.0',
        });
        await expect(
            service.snapshot('codex', {
                excludedAgentSessionIds: ['codex-session-1'],
                rootPath: root,
                processState: 'running',
                startedAt,
            }),
        ).resolves.toMatchObject({
            sessionId: 'codex-session-2',
            title: 'Keep this Terminal',
        });
        await expect(
            service.snapshot('codex', {
                agentSessionId: 'codex-session-older',
                rootPath: root,
                processState: 'stopped',
            }),
        ).resolves.toMatchObject({
            attentionKind: undefined,
            sessionId: 'codex-session-older',
            status: 'completed',
            title: '$debug https://github.com/example/project/issues/1',
            usage: [{ label: 'Tokens', value: '42' }],
        });
    });
});
