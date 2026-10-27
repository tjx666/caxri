import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { StructuredLogger } from '@caxri/system';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import { CaxriDatabase } from '../../db/repository';
import { AgentCoordinator } from '../coordinator';
import { AgentService, createLocalAgentAdapters } from '../service';

const temporaryDirectories: string[] = [];

afterEach(async () => {
    const pendingCleanup = [...temporaryDirectories];
    temporaryDirectories.length = 0;
    await Promise.all(pendingCleanup.map((path) => rm(path, { recursive: true, force: true })));
});

/**
 * End-to-end regression for the Claude session-title chain (real provider `readState` against real on-disk fixtures,
 * through the coordinator probe, into the Session row). Claude Code keeps its `/resume` labels in the project
 * transcript (`ai-title` / `custom-title` records) while the live-session metadata `name` may merely be derived from
 * the working directory. Raw `last-prompt` content must never enter the Session record because native notifications
 * reuse it; the Session keeps the neutral default until a verified title arrives.
 */
describe('AgentCoordinator provider title propagation', () => {
    it('keeps a raw transcript last prompt out of the persisted Session title', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-claude-title-'));
        temporaryDirectories.push(directory);
        const root = join(directory, 'project');
        await mkdir(root);
        const configDirectory = join(directory, 'claude-config');
        const claudeSessionId = '96ed91ed-a4ae-4144-a5f4-bb56725f4e1f';
        await mkdir(join(configDirectory, 'sessions'), { recursive: true });
        const transcriptDirectory = join(
            configDirectory,
            'projects',
            root.replaceAll(/[^a-z0-9]/gi, '-'),
        );
        await mkdir(transcriptDirectory, { recursive: true });

        const database = new CaxriDatabase(join(directory, 'state.db'));
        const created = database.createSession(database.createProject(root).id, 'claude');
        const now = Date.now();
        await writeFile(
            join(configDirectory, 'sessions', '4242.json'),
            JSON.stringify({
                cwd: root,
                name: 'project-1a',
                nameSource: 'derived',
                sessionId: claudeSessionId,
                startedAt: now,
                status: 'idle',
                updatedAt: now,
            }),
        );
        await writeFile(
            join(transcriptDirectory, `${claudeSessionId}.jsonl`),
            `${JSON.stringify({ type: 'last-prompt', lastPrompt: 'hello', sessionId: claudeSessionId })}\n`,
        );

        const coordinator = new AgentCoordinator(
            database,
            new AgentService(
                undefined,
                createLocalAgentAdapters(
                    { homeDirectory: directory, variables: { CLAUDE_CONFIG_DIR: configDirectory } },
                    // A nonexistent executable keeps discovery/version probing inert in tests.
                    () => ({ args: [], executable: join(directory, 'missing-agent') }),
                ),
            ),
            () => {},
            new StructuredLogger(join(directory, 'logs')),
            { refreshDelayMs: 5 },
        );

        try {
            coordinator.observeOutput(created.terminal!.id);

            await expect
                .poll(() => database.getTerminal(created.terminal!.id)?.agentSessionId)
                .toBe(claudeSessionId);
            expect(database.getSession(created.session.id)?.title).toBe('Untitled');
        } finally {
            await coordinator.close();
            database.close();
        }
    });

    it('keeps a raw Codex first prompt out and later mirrors the native thread name', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-codex-title-'));
        temporaryDirectories.push(directory);
        const root = join(directory, 'project');
        const stateDirectory = join(directory, 'codex-state');
        await Promise.all([mkdir(root), mkdir(stateDirectory)]);

        const database = new CaxriDatabase(join(directory, 'state.db'));
        const created = database.createSession(database.createProject(root).id, 'codex');
        const codexSessionId = 'codex-session-sensitive-prompt';
        const rawFirstPrompt = '  Fix\tlogin\nbug  ';
        const provisionalTitle = 'Fix login bug';
        const state = new Database(join(stateDirectory, 'state_1.sqlite'));
        state.exec(
            'CREATE TABLE threads (id TEXT PRIMARY KEY, cwd TEXT, title TEXT, name TEXT, created_at_ms INTEGER, updated_at_ms INTEGER, tokens_used INTEGER, archived INTEGER)',
        );
        state
            .prepare('INSERT INTO threads VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
            .run(
                codexSessionId,
                root,
                rawFirstPrompt,
                null,
                Date.now() + 1_000,
                Date.now() + 1_000,
                0,
                0,
            );
        state.close();

        const missingCodexHome = join(directory, 'missing-codex-home');
        const missingAgent = join(directory, 'missing-agent');
        const coordinator = new AgentCoordinator(
            database,
            new AgentService(
                undefined,
                createLocalAgentAdapters(
                    {
                        homeDirectory: directory,
                        variables: {
                            CODEX_HOME: missingCodexHome,
                            CODEX_SQLITE_HOME: stateDirectory,
                        },
                    },
                    () => ({ args: [], executable: missingAgent }),
                ),
            ),
            () => {},
            new StructuredLogger(join(directory, 'logs')),
            { refreshDelayMs: 5 },
        );

        try {
            coordinator.observeOutput(created.terminal!.id);

            await expect
                .poll(() => database.getTerminal(created.terminal!.id)?.agentSessionId)
                .toBe(codexSessionId);
            expect(database.getSession(created.session.id)?.title).toBe('Untitled');

            const updatedState = new Database(join(stateDirectory, 'state_1.sqlite'));
            updatedState
                .prepare('UPDATE threads SET name = ?, updated_at_ms = ? WHERE id = ?')
                .run(provisionalTitle, Date.now() + 2_000, codexSessionId);
            updatedState.close();
            coordinator.observeOutput(created.terminal!.id);

            await new Promise((resolve) => setTimeout(resolve, 25));
            expect(database.getSession(created.session.id)?.title).toBe('Untitled');
            expect(database.getSession(created.session.id)?.title).not.toContain(provisionalTitle);

            const finalState = new Database(join(stateDirectory, 'state_1.sqlite'));
            finalState
                .prepare('UPDATE threads SET name = ?, updated_at_ms = ? WHERE id = ?')
                .run('Refine Session Naming', Date.now() + 3_000, codexSessionId);
            finalState.close();
            coordinator.observeOutput(created.terminal!.id);

            await expect
                .poll(() => database.getSession(created.session.id)?.title)
                .toBe('Refine Session Naming');
        } finally {
            await coordinator.close();
            database.close();
        }
    });
});
