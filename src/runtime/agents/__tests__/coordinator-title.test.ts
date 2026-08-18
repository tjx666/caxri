import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { StructuredLogger } from '../../../shared/node/logger';
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
 * transcript (`ai-title` / `last-prompt` records) while the live-session metadata `name` is merely derived from the
 * working directory — a coordinator probe must surface the transcript label, not the derived name.
 */
describe('AgentCoordinator Claude title propagation', () => {
    it('publishes the transcript last-prompt label instead of the derived session name', async () => {
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
                .poll(() => database.getSession(created.session.id)?.displayTitle)
                .toBe('hello');
            expect(database.getTerminal(created.terminal!.id)?.agentSessionId).toBe(
                claudeSessionId,
            );
        } finally {
            coordinator.close();
            database.close();
        }
    });
});
