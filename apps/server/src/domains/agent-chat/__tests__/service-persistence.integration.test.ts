import type { AgentChatSnapshot } from '@caxri/protocol';
import { CaxriError } from '@caxri/protocol';
import { describe, expect, it, vi } from 'vitest';

import { chatStateStore } from '../chat-state-store';
import type { AgentChatService } from '../service';
import { fixture } from './chat-service-fixture';

const isSettled = (snapshot: AgentChatSnapshot, turns: number): boolean =>
    snapshot.status === 'ready' &&
    snapshot.turns.length === turns &&
    !snapshot.activeTurnId &&
    snapshot.turns.every((turn) => turn.status === 'completed');

/**
 * Reads a Chat through a service that has just started, until its provider is ready and its history replayed.
 */
async function readSettled(
    service: AgentChatService,
    terminalId: string,
    turns: number,
): Promise<AgentChatSnapshot> {
    service.read(terminalId);
    await vi.waitFor(() => expect(isSettled(service.read(terminalId), turns)).toBe(true), {
        timeout: 5_000,
        interval: 10,
    });
    return service.read(terminalId);
}

function timeline(snapshot: AgentChatSnapshot): string[] {
    return snapshot.items.map((item) =>
        item.type === 'notice'
            ? `notice: ${item.message}`
            : `${item.type}: ${'text' in item ? item.text : ''}`,
    );
}

describe('Agent Chat state that outlives Server Core', () => {
    it('keeps an answered question after a Server Core restart (#1940)', async () => {
        const { service, restartServer, terminal, until, database } = await fixture();
        await service.send(terminal.id, { text: 'ask me' });
        const pending = await until((snapshot) => snapshot.requests.length === 1);
        service.respond(terminal.id, pending.requests[0].id, {
            kind: 'answers',
            answers: { color: ['Blue'] },
        });
        await until((snapshot) => snapshot.turns.at(-1)?.status === 'completed');
        expect(chatStateStore(database).answeredNotices.list(terminal.id)).toHaveLength(1);

        const restarted = await restartServer();
        const snapshot = await readSettled(restarted, terminal.id, 1);
        expect(timeline(snapshot)).toEqual([
            'userMessage: ask me',
            'notice: Color: Blue',
            'agentMessage: You chose Blue.',
        ]);
        // The notice stays saved: a second restart restores it again.
        const again = await readSettled(await restartServer(), terminal.id, 1);
        expect(timeline(again)).toEqual(timeline(snapshot));
    });

    it('drops the saved notice when a rewind removes its turn (#1940)', async () => {
        const { service, restartServer, terminal, until, database } = await fixture();
        await service.send(terminal.id, { text: 'first' });
        await until((snapshot) => isSettled(snapshot, 1));
        await service.send(terminal.id, { text: 'ask me' });
        const pending = await until((snapshot) => snapshot.requests.length === 1);
        service.respond(terminal.id, pending.requests[0].id, {
            kind: 'answers',
            answers: { color: ['Blue'] },
        });
        await until((snapshot) => isSettled(snapshot, 2));
        expect(chatStateStore(database).answeredNotices.list(terminal.id)).toHaveLength(1);

        const asked = service
            .read(terminal.id)
            .items.find((item) => item.type === 'userMessage' && item.text === 'ask me');
        if (!asked) throw new Error('The question message is missing');
        await service.rewind(terminal.id, {
            itemId: asked.id,
            restoreFiles: false,
            message: { text: 'plain' },
        });
        await until((snapshot) => isSettled(snapshot, 2));
        expect(chatStateStore(database).answeredNotices.list(terminal.id)).toEqual([]);

        const restarted = await restartServer();
        const snapshot = await readSettled(restarted, terminal.id, 2);
        expect(snapshot.items.some((item) => item.type === 'notice')).toBe(false);
    });

    it('keeps a Claude rewind point through a failed send and a Server Core restart (#1720)', async () => {
        const { service, restartServer, terminal, until, database } = await fixture({
            provider: 'claude',
        });
        for (const [index, text] of ['first', 'second', 'third'].entries()) {
            // eslint-disable-next-line no-await-in-loop -- each turn must finish before the next is sent
            await service.send(terminal.id, { text });
            // eslint-disable-next-line no-await-in-loop -- see above
            await until((snapshot) => isSettled(snapshot, index + 1));
        }
        const second = service
            .read(terminal.id)
            .items.find((item) => item.type === 'userMessage' && item.text === 'second');
        if (!second) throw new Error('The second message is missing');

        vi.spyOn(service, 'send').mockRejectedValueOnce(new CaxriError('UNAVAILABLE', 'no send'));
        await expect(
            service.rewind(terminal.id, {
                itemId: second.id,
                restoreFiles: false,
                message: { text: 'second, rewritten' },
            }),
        ).rejects.toThrow(/rewound, but the message was not sent/u);
        expect(chatStateStore(database).resumeAt(terminal.id)).toBeDefined();

        const restarted = await restartServer();
        const snapshot = await readSettled(restarted, terminal.id, 1);
        expect(timeline(snapshot)).toEqual([
            'userMessage: first',
            'reasoning: Considering the request.',
            'agentMessage: Hello from fake Claude. You said: first',
        ]);

        // The first new turn writes past the rewind point, so the point is cleared.
        await restarted.send(terminal.id, { text: 'again' });
        await readSettled(restarted, terminal.id, 2);
        expect(chatStateStore(database).resumeAt(terminal.id)).toBeUndefined();
    });
});
