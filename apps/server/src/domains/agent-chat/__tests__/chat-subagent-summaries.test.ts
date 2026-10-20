import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { AgentChatTask } from '@caxri/protocol';
import { describe, expect, it, onTestFinished, vi } from 'vitest';

import { CaxriDatabase } from '../../db';
import { chatStateStore } from '../chat-state-store';
import { ChatSubagentSummaries } from '../chat-subagent-summaries';

async function setup() {
    const directory = await mkdtemp(join(tmpdir(), 'caxri-chat-subagents-'));
    const database = new CaxriDatabase(join(directory, 'state.db'));
    onTestFinished(async () => {
        database.close();
        await rm(directory, { recursive: true, force: true });
    });
    const project = database.createProject(join(directory, 'project'));
    const { session } = database.createSession(project.id, null);
    const chat = database.createTerminal(session.id, 'claude', undefined, 'chat');
    const publish = vi.fn();
    return { chat, database, publish, summaries: new ChatSubagentSummaries(database, publish) };
}

function task(id: string, fields: Partial<AgentChatTask> = {}): AgentChatTask {
    return {
        id,
        kind: 'agent',
        title: `Task ${id}`,
        status: 'running',
        isBackground: true,
        canStop: true,
        startedAt: 1,
        ...fields,
    };
}

describe('ChatSubagentSummaries', () => {
    it('persists subagents only and announces the Terminal record once per summary change', async () => {
        const { chat, database, publish, summaries } = await setup();
        const shell = task('sh', { kind: 'shell' });
        summaries.record(chat.id, [task('a'), shell]);
        expect(chatStateStore(database).subagents.list(chat.id)).toMatchObject([
            { taskId: 'a', status: 'running' },
        ]);
        expect(publish).toHaveBeenCalledTimes(1);

        // Streaming noise (usage, last tool) does not touch the summary, so nothing is written or announced.
        summaries.record(chat.id, [
            task('a', { usage: { totalTokens: 10 }, lastToolName: 'Read' }),
            shell,
        ]);
        expect(publish).toHaveBeenCalledTimes(1);

        summaries.record(chat.id, [task('a', { status: 'completed', endedAt: 9 })]);
        expect(publish).toHaveBeenCalledTimes(2);
        expect(chatStateStore(database).subagents.list(chat.id)).toMatchObject([
            { taskId: 'a', status: 'completed', endedAt: 9 },
        ]);
    });

    it('ignores an empty task list and a deleted Terminal', async () => {
        const { chat, database, publish, summaries } = await setup();
        summaries.record(chat.id, undefined);
        summaries.record(chat.id, []);
        database.closeTerminal(chat.id);
        summaries.record(chat.id, [task('a')]);
        expect(publish).not.toHaveBeenCalled();
    });

    it('reconciles persisted running subagents as stopped on start', async () => {
        const { chat, database, summaries } = await setup();
        summaries.record(chat.id, [task('a')]);
        expect(summaries.reconcileOnStart()).toEqual([chat.id]);
        expect(chatStateStore(database).subagents.list(chat.id)).toMatchObject([
            { taskId: 'a', status: 'stopped' },
        ]);
    });
});
