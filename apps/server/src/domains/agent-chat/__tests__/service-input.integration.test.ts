import type { AgentChatImageInput } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import { fixture } from './chat-service-fixture';

const THUMBNAIL = 'data:image/jpeg;base64,/9j/4AAQ';

function image(data: string): AgentChatImageInput {
    return { mediaType: 'image/png', data, thumbnail: THUMBNAIL };
}

describe('Agent Chat images and slash commands with a fake Codex app-server', () => {
    it('sends images as input and shows their thumbnails in the user message', async () => {
        const { service, spawnProcess, terminal, until } = await fixture();
        await service.send(terminal.id, { text: 'what is this', images: [image('iVBORw0KGgo=')] });
        const snapshot = await until((current) => current.turns.at(-1)?.status === 'completed');
        expect(snapshot.items[0]).toMatchObject({
            type: 'userMessage',
            text: 'what is this',
            images: [{ thumbnail: THUMBNAIL }],
        });
        expect(snapshot.items.at(-1)).toMatchObject({ text: 'Received 1 image.' });

        // A resumed thread knows an image was there, but its preview was the Client's and is gone.
        await service.restart(terminal.id);
        expect(service.read(terminal.id).items[0]).toMatchObject({
            type: 'userMessage',
            images: [{}],
        });
        expect(spawnProcess).toHaveBeenCalledTimes(2);
    });

    it('lists /compact and runs it as a compaction turn', async () => {
        const { service, terminal, until } = await fixture();
        const ready = await until((snapshot) => snapshot.status === 'ready');
        expect(ready.commands?.map((command) => command.name)).toEqual(['compact']);

        await service.runCommand(terminal.id, 'compact');
        const snapshot = await until((current) => current.turns.at(-1)?.status === 'completed');
        expect(snapshot.items).toEqual([expect.objectContaining({ kind: 'compacted' })]);
    });

    it('rejects a command the provider does not list, and queues compaction during a turn', async () => {
        const { service, terminal, until } = await fixture();
        await until((snapshot) => snapshot.status === 'ready');
        await expect(service.runCommand(terminal.id, 'model')).rejects.toMatchObject({
            code: 'VALIDATION',
        });
        await service.send(terminal.id, { text: 'slow please' });
        await until((snapshot) => snapshot.activeTurnId !== undefined);
        await service.runCommand(terminal.id, 'compact');
        expect(service.read(terminal.id).queue).toMatchObject([
            { text: '/compact', command: { name: 'compact' } },
        ]);
        await service.interrupt(terminal.id);
        const paused = await until((snapshot) => !snapshot.activeTurnId);
        expect(paused).toMatchObject({ queuePaused: true, queue: [{ text: '/compact' }] });
    });
});

describe('Agent Chat images and slash commands with a fake Claude Code CLI', () => {
    it('sends images as content blocks and rebuilds them as placeholders on resume', async () => {
        const { service, terminal, until } = await fixture({ provider: 'claude' });
        await service.send(terminal.id, {
            text: '',
            images: [image('iVBORw0KGgo='), image('R0lGODlh')],
        });
        const snapshot = await until((current) => current.turns.at(-1)?.status === 'completed');
        expect(snapshot.items[0]).toMatchObject({
            type: 'userMessage',
            text: '',
            images: [{ thumbnail: THUMBNAIL }, { thumbnail: THUMBNAIL }],
        });
        expect(snapshot.items.at(-1)).toMatchObject({ text: 'Received 2 images.' });

        await service.restart(terminal.id);
        expect(service.read(terminal.id).items[0]).toMatchObject({
            type: 'userMessage',
            images: [{}, {}],
        });
    });

    it("offers Claude Code's commands without its terminal-bound ones, and runs /compact", async () => {
        const { service, terminal, until } = await fixture({ provider: 'claude' });
        const ready = await until((snapshot) => snapshot.status === 'ready');
        expect(ready.commands).toContainEqual({
            name: 'compact',
            description: 'Clear conversation history but keep a summary in context',
            argumentHint: '<optional custom summarization instructions>',
        });

        await service.runCommand(terminal.id, 'compact');
        const snapshot = await until((current) => current.turns.at(-1)?.status === 'completed');
        // The compaction notice stands for the command; `/compact` never shows as a user message.
        expect(snapshot.items.map((item) => item.type)).toEqual(['notice']);
        expect(snapshot.items[0]).toMatchObject({ kind: 'compacted' });
        expect(snapshot.commands?.map((command) => command.name)).toEqual(['compact', 'review']);
    });

    it('clears compaction when Claude Code exits mid-compaction, so later messages are not held', async () => {
        const { service, terminal, until } = await fixture({ provider: 'claude' });
        await until((snapshot) => snapshot.status === 'ready');
        await service.runCommand(terminal.id, 'compact', 'crash');
        const exited = await until((snapshot) => snapshot.status === 'failed');
        expect(exited.operation).toBeUndefined();

        await service.send(terminal.id, { text: 'hello again' });
        const answered = await until((snapshot) => snapshot.turns.at(-1)?.status === 'completed');
        expect(answered.queue ?? []).toEqual([]);
    });
});
