import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MAX_TERMINAL_SUBAGENT_SUMMARIES } from '@caxri/protocol';
import { describe, expect, it, onTestFinished } from 'vitest';

import { AgentChatStateModel, CaxriDatabase } from '../index';

async function openDatabase(): Promise<{ path: string; database: CaxriDatabase }> {
    const directory = await mkdtemp(join(tmpdir(), 'caxri-db-agent-chat-subagents-'));
    onTestFinished(() => rm(directory, { recursive: true, force: true }));
    const path = join(directory, 'state.db');
    return { path, database: new CaxriDatabase(path) };
}

function createChat(database: CaxriDatabase, path: string) {
    const project = database.createProject(join(path, '..', 'project'));
    const { session } = database.createSession(project.id, null);
    return database.createTerminal(session.id, 'claude', undefined, 'chat');
}

describe('Agent Chat subagent summaries', () => {
    it('writes only changed rows and keeps the first-seen start time', async () => {
        const { path, database } = await openDatabase();
        onTestFinished(() => database.close());
        const chat = createChat(database, path);
        const { subagents } = new AgentChatStateModel(database.database);
        expect(
            subagents.sync(chat.id, [{ taskId: 't1', title: 'Explore', status: 'running' }], 100),
        ).toBe(true);
        expect(
            subagents.sync(chat.id, [{ taskId: 't1', title: 'Explore', status: 'running' }], 200),
        ).toBe(false);
        expect(
            subagents.sync(
                chat.id,
                [{ taskId: 't1', title: 'Explore', status: 'completed', endedAt: 300 }],
                300,
            ),
        ).toBe(true);
        expect(subagents.list(chat.id)).toEqual([
            { taskId: 't1', title: 'Explore', status: 'completed', startedAt: 100, endedAt: 300 },
        ]);
    });

    it('trims a Chat to the retention bound, dropping the oldest ended rows first', async () => {
        const { path, database } = await openDatabase();
        onTestFinished(() => database.close());
        const chat = createChat(database, path);
        const { subagents } = new AgentChatStateModel(database.database);
        subagents.sync(chat.id, [
            { taskId: 'running-old', title: 'Still going', status: 'running', startedAt: 1 },
            ...Array.from({ length: MAX_TERMINAL_SUBAGENT_SUMMARIES }, (_, index) => ({
                taskId: `done-${index}`,
                title: 'Done',
                status: 'completed' as const,
                startedAt: 10 + index,
                endedAt: 20 + index,
            })),
        ]);
        const ids = subagents.list(chat.id).map((row) => row.taskId);
        expect(ids).toHaveLength(MAX_TERMINAL_SUBAGENT_SUMMARIES);
        expect(ids).toContain('running-old');
        expect(ids).not.toContain('done-0');
        expect(ids).toContain(`done-${MAX_TERMINAL_SUBAGENT_SUMMARIES - 1}`);
    });

    it('marks persisted running rows stopped on start and deletes rows with their Terminal', async () => {
        const { path, database } = await openDatabase();
        onTestFinished(() => database.close());
        const chat = createChat(database, path);
        const { subagents } = new AgentChatStateModel(database.database);
        subagents.sync(chat.id, [
            { taskId: 'a', title: 'Running', status: 'running', startedAt: 5 },
            { taskId: 'b', title: 'Done', status: 'completed', startedAt: 6, endedAt: 7 },
        ]);
        expect(subagents.stopRunning(50)).toEqual([chat.id]);
        expect(subagents.list(chat.id)).toEqual(
            expect.arrayContaining([
                { taskId: 'a', title: 'Running', status: 'stopped', startedAt: 5, endedAt: 50 },
                { taskId: 'b', title: 'Done', status: 'completed', startedAt: 6, endedAt: 7 },
            ]),
        );
        expect(subagents.stopRunning(60)).toEqual([]);
        database.closeTerminal(chat.id);
        expect(subagents.list(chat.id)).toEqual([]);
    });
});
