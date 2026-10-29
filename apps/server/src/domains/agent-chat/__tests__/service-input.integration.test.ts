import { appendFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

import type { AgentChatImageInput } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import { readChatImage } from '../chat-images';
import { fixture } from './chat-service-fixture';

const THUMBNAIL = 'data:image/jpeg;base64,/9j/4AAQ';

function image(data: string): AgentChatImageInput {
    return { mediaType: 'image/png', data, thumbnail: THUMBNAIL };
}

describe('Agent Chat images and slash commands with a fake Codex app-server', () => {
    it('sends images as input, and reads each back from the rollout once resumed', async () => {
        const { database, agentEnvironment, service, spawnProcess, terminal, until } =
            await fixture({ codexRollouts: true });
        await service.send(terminal.id, {
            text: 'what is this',
            images: [image('iVBORw0KGgo='), image('R0lGODlh')],
        });
        const snapshot = await until((current) => current.turns.at(-1)?.status === 'completed');
        expect(snapshot.items[0]).toMatchObject({
            type: 'userMessage',
            text: 'what is this',
            images: [{ thumbnail: THUMBNAIL }, { thumbnail: THUMBNAIL }],
        });
        expect(snapshot.items.at(-1)).toMatchObject({ text: 'Received 2 images.' });

        // A resumed thread knows an image was there, but its preview was the Client's and is gone.
        await service.restart(terminal.id);
        const resumed = service.read(terminal.id).items[0];
        expect(resumed).toMatchObject({ type: 'userMessage', images: [{}, {}] });
        expect(spawnProcess).toHaveBeenCalledTimes(2);
        // The rollout keeps the original under the item id the app-server resumed the message with.
        const records = { database, agentEnvironment };
        await expect(readChatImage(records, terminal.id, resumed.id, 1)).resolves.toEqual({
            mediaType: 'image/png',
            data: 'R0lGODlh',
        });
        await expect(readChatImage(records, terminal.id, resumed.id, 2)).resolves.toBeNull();
        await expect(readChatImage(records, terminal.id, 'missing', 0)).resolves.toBeNull();
    });

    it('lists /compact and runs it as a compaction turn', async () => {
        const { service, terminal, until } = await fixture();
        const ready = await until((snapshot) => snapshot.status === 'ready');
        expect(ready.commands?.map((command) => command.name)).toEqual([
            'compact',
            'review',
            'goal',
        ]);

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
    it('sends images as content blocks, rebuilds them as placeholders on resume, and reads each back', async () => {
        const { database, agentEnvironment, service, terminal, until } = await fixture({
            provider: 'claude',
        });
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
        const resumed = service.read(terminal.id).items[0];
        expect(resumed).toMatchObject({ type: 'userMessage', images: [{}, {}] });

        // The placeholder's original comes back from the transcript, by the message's id and the image's position.
        const records = { database, agentEnvironment };
        await expect(readChatImage(records, terminal.id, resumed.id, 1)).resolves.toEqual({
            mediaType: 'image/png',
            data: 'R0lGODlh',
        });
        await expect(readChatImage(records, terminal.id, resumed.id, 2)).resolves.toBeNull();
        await expect(readChatImage(records, terminal.id, 'missing', 0)).resolves.toBeNull();
    });

    it('reads an image back once later turns push its message past the resume tail', async () => {
        const { claudeConfigDirectory, database, agentEnvironment, service, terminal, until } =
            await fixture({ provider: 'claude' });
        await service.send(terminal.id, { text: 'look', images: [image('iVBORw0KGgo=')] });
        await until((current) => current.turns.at(-1)?.status === 'completed');
        const { id } = service.read(terminal.id).items[0];
        // Inline screenshots in later tool results make a transcript grow by megabytes per turn.
        const files = await readdir(join(claudeConfigDirectory, 'projects'), {
            recursive: true,
            withFileTypes: true,
        });
        const transcript = files.find((entry) => entry.isFile() && entry.name.endsWith('.jsonl'));
        if (!transcript) throw new Error('fake Claude wrote no transcript');
        await appendFile(
            join(transcript.parentPath, transcript.name),
            `${JSON.stringify({ type: 'system', padding: 'x'.repeat(5 * 1024 * 1024) })}\n`,
        );

        await expect(
            readChatImage({ database, agentEnvironment }, terminal.id, id, 0),
        ).resolves.toEqual({ mediaType: 'image/png', data: 'iVBORw0KGgo=' });
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
        expect(snapshot.commands?.map((command) => command.name)).toEqual([
            'compact',
            'review',
            'goal',
        ]);
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
