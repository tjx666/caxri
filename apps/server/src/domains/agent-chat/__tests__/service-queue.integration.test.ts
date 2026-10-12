import type { AgentChatSnapshot } from '@caxri/protocol';
import { MAX_AGENT_CHAT_QUEUE } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import { fixture } from './chat-service-fixture';

function userTexts(snapshot: AgentChatSnapshot): string[] {
    return snapshot.items.flatMap((item) => (item.type === 'userMessage' ? [item.text] : []));
}

describe('Agent Chat follow-up queue with a fake Codex app-server', () => {
    it('holds messages sent during a turn and sends them together as the next turn, in order', async () => {
        const { service, terminal, until } = await fixture();
        await service.send(terminal.id, { text: 'slow please' });
        await until((snapshot) => snapshot.activeTurnId !== undefined);
        await service.send(terminal.id, { text: 'hello first' });
        await service.send(terminal.id, { text: 'hello second' });
        const queued = await until((snapshot) => snapshot.queue?.length === 2);
        expect(queued.queue?.map((entry) => entry.text)).toEqual(['hello first', 'hello second']);
        expect(userTexts(queued)).toEqual(['slow please']);

        // Stopping the turn pauses the queue instead of firing the next message.
        await service.interrupt(terminal.id);
        const paused = await until((snapshot) => !snapshot.activeTurnId);
        expect(paused.queuePaused).toBe(true);
        expect(userTexts(paused)).toEqual(['slow please']);

        service.resumeQueue(terminal.id);
        const drained = await until(
            (snapshot) =>
                snapshot.queue?.length === 0 &&
                !snapshot.activeTurnId &&
                snapshot.turns.length === 2,
        );
        expect(userTexts(drained)).toEqual(['slow please', 'hello first\n\nhello second']);
        expect(drained.queuePaused).toBe(false);
        expect(drained.turns.map((turn) => turn.status)).toEqual(['interrupted', 'completed']);
    });

    it('keeps queued and steered marks on messages after a restart', async () => {
        const { service, terminal, until } = await fixture();
        await service.send(terminal.id, { text: 'slow please' });
        await until((snapshot) => snapshot.activeTurnId !== undefined);
        await service.send(terminal.id, { text: 'hello steer' }, 'steer');
        await service.send(terminal.id, { text: 'hello queued' });
        await until((snapshot) => snapshot.queue?.length === 1);
        await service.interrupt(terminal.id);
        await until((snapshot) => !snapshot.activeTurnId && snapshot.queuePaused === true);
        service.resumeQueue(terminal.id);
        await until(
            (snapshot) =>
                snapshot.queue?.length === 0 &&
                !snapshot.activeTurnId &&
                snapshot.turns.length === 2,
        );

        // Codex keeps the delivery in each message's `clientId`, so the resumed history still shows it.
        await service.restart(terminal.id);
        const resumed = await until((snapshot) => snapshot.status === 'ready');
        const deliveries = resumed.items.flatMap((item) =>
            item.type === 'userMessage' ? [[item.text, item.delivery]] : [],
        );
        expect(deliveries).toEqual([
            ['slow please', undefined],
            ['hello steer', 'steered'],
            ['hello queued', 'queued'],
        ]);
    });

    it('removes a queued message, and sends another ahead of the queue', async () => {
        const { service, terminal, until } = await fixture();
        await service.send(terminal.id, { text: 'slow please' });
        await until((snapshot) => snapshot.activeTurnId !== undefined);
        await service.send(terminal.id, { text: 'hello drop' });
        await service.send(terminal.id, { text: 'hello keep' });
        const queued = await until((snapshot) => snapshot.queue?.length === 2);
        const [dropId = '', keepId = ''] = queued.queue?.map((entry) => entry.id) ?? [];

        service.removeQueued(terminal.id, dropId);
        expect(() => service.removeQueued(terminal.id, dropId)).toThrow(
            expect.objectContaining({ code: 'CONFLICT' }),
        );
        await service.sendQueuedNow(terminal.id, keepId);
        // The steer's echo can follow its answer, so wait for both.
        const steered = await until(
            (snapshot) => snapshot.queue?.length === 0 && userTexts(snapshot).length === 2,
        );
        expect(userTexts(steered)).toEqual(['slow please', 'hello keep']);
        await expect(service.sendQueuedNow(terminal.id, keepId)).rejects.toMatchObject({
            code: 'CONFLICT',
        });
        await service.interrupt(terminal.id);
    });

    it('keeps a queued message in place when sending it now fails', async () => {
        const { service, terminal, until } = await fixture();
        await service.send(terminal.id, { text: 'slow please' });
        await until((snapshot) => snapshot.activeTurnId !== undefined);
        await service.send(terminal.id, { text: 'hello refuse' });
        await service.send(terminal.id, { text: 'hello after' });
        const queued = await until((snapshot) => snapshot.queue?.length === 2);
        await expect(
            service.sendQueuedNow(terminal.id, queued.queue?.[0]?.id ?? ''),
        ).rejects.toThrow();
        expect(service.read(terminal.id).queue?.map((entry) => entry.text)).toEqual([
            'hello refuse',
            'hello after',
        ]);
        await service.interrupt(terminal.id);
    });

    it('counts a queued message Codex answers late as sent, once', async () => {
        const { service, terminal, until } = await fixture({ turnRequestTimeoutMs: 200 });
        await service.send(terminal.id, { text: 'slow please' });
        await until((snapshot) => snapshot.activeTurnId !== undefined);
        await service.send(terminal.id, { text: 'hello stall' });
        await until((snapshot) => snapshot.queue?.length === 1);
        await service.interrupt(terminal.id);
        await until((snapshot) => !snapshot.activeTurnId && snapshot.queuePaused === true);

        service.resumeQueue(terminal.id);
        const drained = await until(
            (snapshot) =>
                snapshot.turns.length === 2 &&
                !snapshot.activeTurnId &&
                snapshot.turns.every((turn) => turn.status !== 'running'),
        );
        expect(userTexts(drained)).toEqual(['slow please', 'hello stall']);
        expect(drained.queue).toEqual([]);
        expect(drained.queuePaused).toBe(false);
        expect(drained.items.some((item) => item.id.startsWith('delivery-unknown:'))).toBe(false);
    });

    it('holds a queued message Codex never confirms instead of sending it again', async () => {
        const { service, terminal, until } = await fixture({ turnRequestTimeoutMs: 200 });
        await service.send(terminal.id, { text: 'slow please' });
        await until((snapshot) => snapshot.activeTurnId !== undefined);
        await service.send(terminal.id, { text: 'hello lost' });
        await service.send(terminal.id, { text: 'hello after' });
        const queued = await until((snapshot) => snapshot.queue?.length === 2);
        await expect(
            service.sendQueuedNow(terminal.id, queued.queue?.[0]?.id ?? ''),
        ).rejects.toMatchObject({ code: 'TIMEOUT', details: { deliveryUnknown: true } });
        const held = await until((snapshot) => snapshot.queuePaused === true);
        expect(held.queue?.map((entry) => entry.text)).toEqual(['hello lost', 'hello after']);
        expect(held.items).toContainEqual(
            expect.objectContaining({
                type: 'notice',
                kind: 'error',
                id: expect.stringMatching(/^delivery-unknown:/u) as string,
            }),
        );

        // The turn ending does not send the held message or the one behind it.
        await service.interrupt(terminal.id);
        const ended = await until((snapshot) => !snapshot.activeTurnId);
        await new Promise((resolve) => setTimeout(resolve, 100));
        expect(userTexts(service.read(terminal.id))).toEqual(['slow please']);
        expect(ended.queue).toHaveLength(2);
    });

    it('steers the running turn when asked to, without queueing', async () => {
        const { service, terminal, until } = await fixture();
        await service.send(terminal.id, { text: 'slow please' });
        await until((snapshot) => snapshot.activeTurnId !== undefined);
        await service.send(terminal.id, { text: 'hello steer' }, 'steer');
        const steered = await until((snapshot) => userTexts(snapshot).length === 2);
        expect(steered.queue ?? []).toEqual([]);
        expect(steered.turns).toHaveLength(1);
        await service.interrupt(terminal.id);
    });

    it('bounds the queue and keeps it across a restart', async () => {
        const { service, terminal, until } = await fixture();
        await service.send(terminal.id, { text: 'slow please' });
        await until((snapshot) => snapshot.activeTurnId !== undefined);
        await Promise.all(
            Array.from({ length: MAX_AGENT_CHAT_QUEUE }, (_, index) =>
                service.send(terminal.id, { text: `hello ${index}` }),
            ),
        );
        await expect(service.send(terminal.id, { text: 'one too many' })).rejects.toMatchObject({
            code: 'VALIDATION',
        });
        await service.interrupt(terminal.id);
        await until((snapshot) => snapshot.queuePaused === true);

        await service.restart(terminal.id);
        const restarted = service.read(terminal.id);
        expect(restarted.status).toBe('ready');
        expect(restarted.queue).toHaveLength(MAX_AGENT_CHAT_QUEUE);
        expect(restarted.queuePaused).toBe(true);
    });
});
