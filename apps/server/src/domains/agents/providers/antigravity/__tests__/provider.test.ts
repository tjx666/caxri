import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import { antigravityProvider } from '../provider';

const directories: string[] = [];
afterEach(async () => {
    await Promise.all(
        directories.map((directory) => rm(directory, { recursive: true, force: true })),
    );
    directories.length = 0;
});

const conversationId = '49cc1001-2b93-4bb3-9ee8-104e8dcdd683';

async function home() {
    const created = await mkdtemp(join(tmpdir(), 'caxri-antigravity-'));
    const directory = await realpath(created);
    directories.push(directory);
    const state = join(directory, '.gemini', 'antigravity-cli');
    await mkdir(join(state, 'conversations'), { recursive: true });
    return { state, environment: { homeDirectory: directory, variables: {} } };
}

describe('Antigravity launch contract', () => {
    it('starts a fresh conversation with the initial prompt and no identity of its own', async () => {
        const { environment } = await home();
        expect(
            await antigravityProvider.prepareLaunch!({
                args: ['--model', 'gemini-fake'],
                cwd: environment.homeDirectory,
                environment,
                initialPrompt: 'Synthetic task pointer',
            }),
        ).toEqual({ args: ['--model', 'gemini-fake', '-i', 'Synthetic task pointer'] });
    });

    it('resumes a conversation that exists locally and refuses one that does not', async () => {
        const { state, environment } = await home();
        const input = { args: [], cwd: environment.homeDirectory, environment };
        await expect(
            antigravityProvider.prepareLaunch!({ ...input, resumeAgentSessionId: conversationId }),
        ).rejects.toMatchObject({
            code: 'UNAVAILABLE',
            details: { reason: 'agent_session_unavailable' },
        });
        await writeFile(join(state, 'conversations', `${conversationId}.db`), '');
        expect(
            await antigravityProvider.prepareLaunch!({
                ...input,
                resumeAgentSessionId: conversationId,
            }),
        ).toEqual({
            agentSessionId: conversationId,
            args: ['--conversation', conversationId],
        });
    });

    it('rejects launch settings that pick another conversation or leave the interactive terminal', async () => {
        const { environment } = await home();
        await Promise.all(
            ['--conversation=x', '-c', '--print', '-p', '-i', '--output-format', '--'].map((flag) =>
                expect(
                    antigravityProvider.prepareLaunch!({
                        args: [flag],
                        cwd: environment.homeDirectory,
                        environment,
                    }),
                ).rejects.toThrow('manages Antigravity'),
            ),
        );
    });
});

describe('Antigravity state probe', () => {
    async function summaries(rows: Array<{ id: string; title: string; preview: string }>) {
        const { state, environment } = await home();
        const database = new Database(join(state, 'conversation_summaries.db'));
        database.exec(
            'CREATE TABLE conversation_summaries (conversation_id text PRIMARY KEY, title text NOT NULL DEFAULT "", preview text NOT NULL DEFAULT "")',
        );
        const insert = database.prepare('INSERT INTO conversation_summaries VALUES (?, ?, ?)');
        for (const row of rows) insert.run(row.id, row.title, row.preview);
        database.close();
        return environment;
    }

    it("reads the bound conversation's generated title and never its first prompt", async () => {
        const environment = await summaries([
            { id: conversationId, title: 'Fix Flaky Login Test', preview: 'raw first prompt' },
            { id: 'other', title: 'Another Conversation', preview: 'other prompt' },
        ]);
        const context = { rootPath: environment.homeDirectory, agentSessionId: conversationId };
        expect(await antigravityProvider.readState(context, environment)).toEqual({
            title: 'Fix Flaky Login Test',
            titleSource: 'automatic',
        });
    });

    it('reads nothing for an unbound Terminal, an untitled conversation, or a missing index', async () => {
        const environment = await summaries([
            { id: conversationId, title: '', preview: 'raw first prompt' },
        ]);
        const root = { rootPath: environment.homeDirectory };
        expect(await antigravityProvider.readState(root, environment)).toBeUndefined();
        expect(
            await antigravityProvider.readState(
                { ...root, agentSessionId: conversationId },
                environment,
            ),
        ).toBeUndefined();
        const { environment: empty } = await home();
        expect(
            await antigravityProvider.readState(
                { rootPath: empty.homeDirectory, agentSessionId: conversationId },
                empty,
            ),
        ).toBeUndefined();
    });
});
