import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { clearExecutableCache } from '../../../discovery';
import { AgentService, createLocalAgentAdapters } from '../../../service';
import { codexProvider, codexSessionIdsFromOpenFiles } from '..';

const temporaryDirectories: string[] = [];

afterEach(async () => {
    clearExecutableCache();
    vi.unstubAllEnvs();
    const pendingCleanup = [...temporaryDirectories];
    temporaryDirectories.length = 0;
    await Promise.all(pendingCleanup.map((path) => rm(path, { recursive: true, force: true })));
});

describe('Codex reverted threads', () => {
    it('identifies a reverted thread from its rollout-suffixed live rollout', () => {
        const sessionsRoot = '/Users/dev/.codex/sessions';
        const threadId = '01931f2e-7b0a-7abc-8def-0123456789ab';
        const rollout = `rollout-2026-09-08T09-34-55-${threadId}_01932f30-0001-7abc-8def-0123456789aa.jsonl`;

        expect(
            codexSessionIdsFromOpenFiles(
                [{ access: 'u', path: join(sessionsRoot, '2026', '09', '08', rollout), pid: 42 }],
                sessionsRoot,
            ),
        ).toEqual([threadId]);
    });

    /**
     * Reverting a thread moves new turns onto a fresh rollout ID while the retained prefix stays under the thread ID.
     * Reading only the thread ID left a running turn invisible, so the Session lost its Working state mid-turn.
     */
    it('reads turns a reverted thread writes under its current rollout ID', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-agent-codex-reverted-'));
        temporaryDirectories.push(directory);
        const root = join(directory, 'project');
        const state = join(directory, 'codex-state');
        const bin = join(directory, 'bin');
        await Promise.all([mkdir(root), mkdir(state), mkdir(bin)]);
        const executable = join(bin, 'codex');
        await writeFile(executable, '#!/bin/sh\nprintf "codex 1.0\\n"\n', 'utf8');
        await chmod(executable, 0o700);
        const threadId = '01931f2e-7b0a-7abc-8def-0123456789ab';
        const rolloutId = '01932f30-0001-7abc-8def-0123456789aa';
        const threads = new Database(join(state, 'state_5.sqlite'));
        threads.exec(
            'CREATE TABLE threads (id TEXT PRIMARY KEY, cwd TEXT, rollout_path TEXT, updated_at_ms INTEGER)',
        );
        threads
            .prepare('INSERT INTO threads VALUES (?, ?, ?, ?)')
            .run(
                threadId,
                root,
                join(
                    directory,
                    'sessions',
                    '2026',
                    '09',
                    '08',
                    `rollout-2026-09-08T09-34-55-${threadId}_${rolloutId}.jsonl`,
                ),
                Date.now(),
            );
        threads.close();
        const turnHistory = new Database(join(state, 'thread_history_1.sqlite'));
        turnHistory.exec(
            'CREATE TABLE thread_turns (thread_id TEXT, turn_id TEXT, rollout_ordinal INTEGER, status TEXT)',
        );
        const insertTurn = turnHistory.prepare('INSERT INTO thread_turns VALUES (?, ?, ?, ?)');
        insertTurn.run(threadId, 'turn-retained', 1, 'completed');
        // Dropped by the revert, yet its ordinal still outranks the current rollout's turn.
        insertTurn.run(threadId, 'turn-reverted', 9, 'interrupted');
        insertTurn.run(rolloutId, 'turn-current', 5, 'inProgress');
        turnHistory.close();
        vi.stubEnv('PATH', bin);
        vi.stubEnv('SHELL', '/usr/bin/false');
        const environment = {
            homeDirectory: directory,
            variables: {
                CLAUDE_CONFIG_DIR: join(directory, 'missing'),
                CODEX_HOME: join(directory, 'missing-codex-home'),
                CODEX_SQLITE_HOME: state,
            },
        };
        const service = new AgentService(undefined, createLocalAgentAdapters(environment));

        await expect(
            service.snapshot('codex', {
                agentSessionId: threadId,
                rootPath: root,
                processState: 'running',
                startedAt: Date.now(),
            }),
        ).resolves.toMatchObject({
            activitySource: 'latestTurn',
            activityTurnId: 'turn-current',
            sessionId: threadId,
            status: 'running',
        });
        await expect(
            codexProvider.readTurnStatus?.(
                { agentSessionId: threadId, agentTurnId: 'turn-current' },
                environment,
            ),
        ).resolves.toBe('running');
    });
});
