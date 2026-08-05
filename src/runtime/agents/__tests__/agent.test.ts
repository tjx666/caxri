import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';

import { StructuredLogger } from '../../../shared/node/logger';
import { clearExecutableCache, discoverExecutable } from '../discovery';
import { AgentService, createLocalAgentAdapters, type AgentAdapter } from '../service';

const temporaryDirectories: string[] = [];

afterEach(async () => {
    clearExecutableCache();
    vi.unstubAllEnvs();
    await Promise.all(
        temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
    );
});

describe('Agent adapter fallback', () => {
    it('returns unknown without failing when a CLI cannot be discovered', async () => {
        vi.stubEnv('PATH', '');
        vi.stubEnv('SHELL', '/usr/bin/false');

        await expect(
            new AgentService().snapshot('claude', { rootPath: '/definitely/missing' }),
        ).resolves.toMatchObject({
            provider: 'claude',
            status: 'unknown',
            available: false,
        });
    });

    it('validates the final executable path from login-shell output and invalidates stale cache', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-agent-discovery-'));
        temporaryDirectories.push(directory);
        const executable = join(directory, 'codex');
        const shell = join(directory, 'login-shell');
        await writeFile(executable, '#!/bin/sh\n', 'utf8');
        await chmod(executable, 0o700);
        await writeFile(shell, `#!/bin/sh\nprintf 'shell banner\\n${executable}\\n'\n`, 'utf8');
        await chmod(shell, 0o700);
        vi.stubEnv('PATH', '');
        vi.stubEnv('SHELL', shell);

        await expect(discoverExecutable('codex')).resolves.toBe(executable);
        await chmod(executable, 0o600);
        await expect(discoverExecutable('codex')).resolves.toBeUndefined();
    });

    it('shares a concurrent provider probe', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-agent-'));
        temporaryDirectories.push(directory);
        const snapshot = vi.fn<AgentAdapter['snapshot']>(() =>
            Promise.resolve({
                provider: 'codex',
                status: 'unknown',
                observedAt: Date.now(),
                available: true,
            }),
        );
        const logger = new StructuredLogger(join(directory, 'logs'));
        const service = new AgentService(logger, {
            claude: { provider: 'claude', snapshot },
            codex: { provider: 'codex', snapshot },
        });

        await expect(
            Promise.all([service.snapshot('codex'), service.snapshot('codex')]),
        ).resolves.toHaveLength(2);
        expect(snapshot).toHaveBeenCalledTimes(1);
        const records = (await readFile(logger.path, 'utf8'))
            .trim()
            .split('\n')
            .map((line) => JSON.parse(line) as { event: string; durationMs?: number });
        expect(records.filter((record) => record.event === 'agent.probe')).toHaveLength(1);
        expect(records.find((record) => record.event === 'agent.probe')?.durationMs).toBeTypeOf(
            'number',
        );
    });

    it('discovers Claude Code and Codex independently for one Project', async () => {
        const claudeSnapshot = vi.fn<AgentAdapter['snapshot']>(() =>
            Promise.resolve({
                provider: 'claude',
                status: 'waiting',
                observedAt: Date.now(),
                available: true,
                sessionId: 'claude-session-1',
            }),
        );
        const codexSnapshot = vi.fn<AgentAdapter['snapshot']>(() =>
            Promise.resolve({
                provider: 'codex',
                status: 'running',
                observedAt: Date.now(),
                available: true,
                sessionId: 'codex-session-1',
            }),
        );
        const service = new AgentService(undefined, {
            claude: { provider: 'claude', snapshot: claudeSnapshot },
            codex: { provider: 'codex', snapshot: codexSnapshot },
        });

        await expect(
            Promise.all([
                service.snapshot('claude', { rootPath: '/project' }),
                service.snapshot('codex', { rootPath: '/project' }),
            ]),
        ).resolves.toEqual([
            expect.objectContaining({ provider: 'claude', sessionId: 'claude-session-1' }),
            expect.objectContaining({ provider: 'codex', sessionId: 'codex-session-1' }),
        ]);
        expect(claudeSnapshot).toHaveBeenCalledTimes(1);
        expect(codexSnapshot).toHaveBeenCalledTimes(1);
    });

    it('reads Claude Code live-session metadata without opening transcripts', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-agent-claude-state-'));
        temporaryDirectories.push(directory);
        const root = join(directory, 'project');
        const config = join(directory, 'claude');
        const bin = join(directory, 'bin');
        await Promise.all([
            mkdir(root),
            mkdir(join(config, 'sessions'), { recursive: true }),
            mkdir(bin),
        ]);
        const executable = join(bin, 'claude');
        await writeFile(executable, '#!/bin/sh\nprintf "claude 1.0\\n"\n', 'utf8');
        await chmod(executable, 0o700);
        const metadataStartedAt = Date.now() - 1_000;
        await writeFile(
            join(config, 'sessions', 'session.json'),
            JSON.stringify({
                cwd: root,
                name: 'Repair terminal lifecycle',
                sessionId: 'claude-session-1',
                startedAt: new Date(metadataStartedAt + 1).toISOString(),
                status: 'busy',
                updatedAt: new Date(metadataStartedAt + 20).toISOString(),
            }),
            'utf8',
        );
        await writeFile(
            join(config, 'sessions', 'other-session.json'),
            JSON.stringify({
                cwd: root,
                name: 'Keep this Terminal',
                sessionId: 'claude-session-2',
                startedAt: new Date(metadataStartedAt + 2).toISOString(),
                status: 'idle',
                updatedAt: new Date(metadataStartedAt + 10).toISOString(),
            }),
            'utf8',
        );
        vi.stubEnv('PATH', bin);
        vi.stubEnv('SHELL', '/usr/bin/false');
        const service = new AgentService(
            undefined,
            createLocalAgentAdapters({
                claudeConfigDirectory: config,
                codexStateDirectories: [],
            }),
        );

        await expect(
            service.snapshot('claude', { rootPath: root, processState: 'running' }),
        ).resolves.toMatchObject({
            available: true,
            sessionId: 'claude-session-1',
            status: 'running',
            title: 'Repair terminal lifecycle',
            version: 'claude 1.0',
        });
        await expect(
            service.snapshot('claude', {
                excludedAgentSessionIds: ['claude-session-1'],
                rootPath: root,
                processState: 'running',
            }),
        ).resolves.toMatchObject({
            sessionId: 'claude-session-2',
            title: 'Keep this Terminal',
        });
    });

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
                claudeConfigDirectory: join(directory, 'missing'),
                codexStateDirectories: [state],
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
                processState: 'running',
            }),
        ).resolves.toMatchObject({
            sessionId: 'codex-session-older',
            title: '$debug https://github.com/example/project/issues/1',
            usage: [{ label: 'Tokens', value: '42' }],
        });
    });
});
