import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, onTestFinished } from 'vitest';

import { chatStateStore } from '../../agent-chat';
import { CaxriDatabase } from '../../db';
import { createLiveTerminalRecord } from '../live-terminal-record';

describe('createLiveTerminalRecord', () => {
    it('projects persisted subagents onto a Chat Terminal record and nothing onto a PTY one', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-live-terminal-'));
        const database = new CaxriDatabase(join(directory, 'state.db'));
        onTestFinished(async () => {
            database.close();
            await rm(directory, { recursive: true, force: true });
        });
        const project = database.createProject(join(directory, 'project'));
        const { session } = database.createSession(project.id, null);
        const chat = database.createTerminal(session.id, 'claude', undefined, 'chat');
        const pty = database.createTerminal(session.id, 'claude');
        for (const terminal of [chat, pty])
            chatStateStore(database).subagents.sync(terminal.id, [
                { taskId: 't1', title: 'Explore', status: 'completed', endedAt: 5 },
            ]);
        const live = createLiveTerminalRecord(
            { agentOperation: () => {} },
            { processId: () => {} },
            chatStateStore(database).subagents,
        );
        expect(live(chat).subagents).toMatchObject([{ taskId: 't1', status: 'completed' }]);
        expect(live(pty).subagents).toBeUndefined();
        const empty = database.createTerminal(session.id, 'codex', undefined, 'chat');
        expect(live(empty)).not.toHaveProperty('subagents');
    });
});
