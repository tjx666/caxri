import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MAX_AGENT_CHAT_VERSIONS } from '@caxri/protocol';
import { describe, expect, it, onTestFinished } from 'vitest';

import { AgentChatStateModel, CaxriDatabase } from '../index';

async function openChat() {
    const directory = await mkdtemp(join(tmpdir(), 'caxri-db-agent-chat-versions-'));
    onTestFinished(() => rm(directory, { recursive: true, force: true }));
    const database = new CaxriDatabase(join(directory, 'state.db'));
    onTestFinished(() => database.close());
    const project = database.createProject(join(directory, 'project'));
    const { session } = database.createSession(project.id, null);
    const chat = database.createTerminal(session.id, 'codex', undefined, 'chat');
    return { database, chat, versions: new AgentChatStateModel(database.database).versions };
}

const message = (id: string) => ({ id, type: 'userMessage' as const, text: id, turnId: id });

describe('Agent Chat versions', () => {
    it('lists a conversation’s versions oldest first and reads their content back', async () => {
        const { chat, versions } = await openChat();
        for (const [index, id] of ['a', 'b'].entries())
            versions.save(
                {
                    terminalId: chat.id,
                    id,
                    agentSessionId: 'thread-1',
                    anchorTurnId: 'turn-1',
                    items: [message(id)],
                    turns: [{ id, status: 'completed' }],
                },
                index,
            );
        versions.save(
            {
                terminalId: chat.id,
                id: 'other',
                agentSessionId: 'thread-2',
                anchorTurnId: null,
                items: [],
                turns: [],
            },
            5,
        );
        expect(versions.list(chat.id, 'thread-1')).toEqual([
            { id: 'a', parentVersionId: null, anchorTurnId: 'turn-1', createdAt: 0 },
            { id: 'b', parentVersionId: null, anchorTurnId: 'turn-1', createdAt: 1 },
        ]);
        expect(versions.read(chat.id, 'b')).toEqual({
            items: [message('b')],
            turns: [{ id: 'b', status: 'completed' }],
        });
        expect(versions.read(chat.id, 'missing')).toBeUndefined();

        versions.setAnchor(chat.id, 'a', 'history:1');
        versions.moveSession(chat.id, 'thread-1', 'thread-3');
        expect(versions.list(chat.id, 'thread-1')).toEqual([]);
        expect(versions.list(chat.id, 'thread-3').map((version) => version.anchorTurnId)).toEqual([
            'history:1',
            'turn-1',
        ]);
        versions.remove(chat.id, 'b');
        expect(versions.list(chat.id, 'thread-3').map((version) => version.id)).toEqual(['a']);
    });

    it('nests the versions anchored in replaced turns under the new version, and drops them with it', async () => {
        const { chat, versions } = await openChat();
        const save = (id: string, anchorTurnId: string | null, turnIds: string[], now: number) =>
            versions.save(
                {
                    terminalId: chat.id,
                    id,
                    agentSessionId: 'thread-1',
                    anchorTurnId,
                    items: [],
                    turns: turnIds.map((turnId) => ({ id: turnId, status: 'completed' as const })),
                },
                now,
            );
        // Edit the third message, then the first: the first edit's anchor (turn 2) is among the turns the second replaces.
        save('inner', 'turn-2', ['turn-3'], 1);
        save('outer', null, ['turn-1', 'turn-2', 'turn-3b'], 2);
        expect(
            versions
                .list(chat.id, 'thread-1')
                .map(({ id, parentVersionId }) => [id, parentVersionId]),
        ).toEqual([
            ['inner', 'outer'],
            ['outer', null],
        ]);
    });

    it('drops the oldest versions past the per-Chat bound', async () => {
        const { chat, versions } = await openChat();
        for (let index = 0; index <= MAX_AGENT_CHAT_VERSIONS; index += 1)
            versions.save(
                {
                    terminalId: chat.id,
                    id: `v${index}`,
                    agentSessionId: null,
                    anchorTurnId: null,
                    items: [],
                    turns: [],
                },
                index,
            );
        const kept = versions.list(chat.id, null);
        expect(kept).toHaveLength(MAX_AGENT_CHAT_VERSIONS);
        expect(kept[0].id).toBe('v1');
    });

    it('goes away with its Terminal and ignores a save for a deleted one', async () => {
        const { database, chat, versions } = await openChat();
        database.closeTerminal(chat.id);
        expect(() =>
            versions.save({
                terminalId: chat.id,
                id: 'late',
                agentSessionId: null,
                anchorTurnId: null,
                items: [],
                turns: [],
            }),
        ).not.toThrow();
        expect(versions.list(chat.id, null)).toEqual([]);
    });
});
