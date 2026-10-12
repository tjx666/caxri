import { describe, expect, it } from 'vitest';

import type {
    AgentChatAttachmentBackend,
    PersistedAgentChatAttachment,
    PersistedAgentChatAttachmentRecord,
} from '../agent-chat-attachment-persistence';
import {
    agentChatAttachmentCharacters,
    agentChatAttachmentEvictions,
    createAgentChatAttachmentPersistence,
    parsePersistedAgentChatAttachments,
} from '../agent-chat-attachment-persistence';

const THUMBNAIL = 'data:image/jpeg;base64,AAAA';

function attachment(id: string, data = 'AAAA'): PersistedAgentChatAttachment {
    return { id, image: { mediaType: 'image/png', data, thumbnail: THUMBNAIL }, name: `${id}.png` };
}

/**
 * An in-memory backend standing in for IndexedDB, holding whatever an earlier run wrote, malformed values included.
 */
function memoryBackend(initial: unknown[] = []) {
    const records = new Map<string, unknown>();
    for (const value of initial)
        records.set((value as { terminalId?: string }).terminalId ?? crypto.randomUUID(), value);
    const backend: AgentChatAttachmentBackend = {
        readAll: () => Promise.resolve(records.values().toArray()),
        put: (record: PersistedAgentChatAttachmentRecord) => {
            records.set(record.terminalId, structuredClone(record));
            return Promise.resolve();
        },
        delete: (terminalId) => {
            records.delete(terminalId);
            return Promise.resolve();
        },
    };
    return { backend, records };
}

function clock() {
    let time = 0;
    return () => {
        time += 1;
        return time;
    };
}

describe('parsePersistedAgentChatAttachments', () => {
    it('keeps valid attachments and drops malformed ones one by one', () => {
        const valid = attachment('a');
        expect(
            parsePersistedAgentChatAttachments([
                valid,
                { ...valid, id: '' },
                { id: 'b', image: { mediaType: 'image/bmp', data: 'AAAA', thumbnail: THUMBNAIL } },
                {
                    id: 'c',
                    image: { mediaType: 'image/png', data: 'not base64!', thumbnail: THUMBNAIL },
                },
                'garbage',
                null,
                { ...attachment('d'), isResized: true, name: 3 },
            ]),
        ).toEqual([valid, { id: 'd', image: attachment('d').image, isResized: true }]);
        expect(parsePersistedAgentChatAttachments({ not: 'a list' })).toEqual([]);
    });
});

describe('agentChatAttachmentEvictions', () => {
    it('drops the least recently changed Chats until the rest fit', () => {
        const sizes = new Map([
            ['newest', { characters: 40, updatedAt: 3 }],
            ['oldest', { characters: 40, updatedAt: 1 }],
            ['middle', { characters: 40, updatedAt: 2 }],
        ]);
        expect(agentChatAttachmentEvictions(sizes, 120)).toEqual([]);
        expect(agentChatAttachmentEvictions(sizes, 80)).toEqual(['oldest']);
        expect(agentChatAttachmentEvictions(sizes, 39)).toEqual(['oldest', 'middle', 'newest']);
    });
});

describe('createAgentChatAttachmentPersistence', () => {
    it('restores what an earlier run saved, and forgets a Chat whose images were sent', async () => {
        const { backend } = memoryBackend();
        const earlier = createAgentChatAttachmentPersistence({ backend, now: clock() });
        earlier.save('chat-a', [attachment('a')]);
        earlier.save('chat-b', [attachment('b')]);
        earlier.save('chat-b', []);
        await earlier.flushed();

        const later = createAgentChatAttachmentPersistence({ backend, now: clock() });
        await expect(later.hydrate()).resolves.toEqual(new Map([['chat-a', [attachment('a')]]]));
    });

    it('drops corrupt records and deletes them from the store', async () => {
        const { backend, records } = memoryBackend([
            { terminalId: 'chat-a', attachments: [attachment('a'), { id: 'x' }], updatedAt: 1 },
            { terminalId: 'chat-b', attachments: 'corrupt', updatedAt: 2 },
            { attachments: [attachment('c')] },
            'garbage',
        ]);
        const persistence = createAgentChatAttachmentPersistence({ backend });
        await expect(persistence.hydrate()).resolves.toEqual(
            new Map([['chat-a', [attachment('a')]]]),
        );
        await persistence.flushed();
        expect(records.has('chat-b')).toBe(false);
    });

    it('drops the oldest Chats past the limit, on write and on restore', async () => {
        const size = agentChatAttachmentCharacters([attachment('a')]);
        const { backend, records } = memoryBackend();
        const persistence = createAgentChatAttachmentPersistence({
            backend,
            limit: size * 2,
            now: clock(),
        });
        persistence.save('chat-a', [attachment('a')]);
        persistence.save('chat-b', [attachment('b')]);
        persistence.save('chat-c', [attachment('c')]);
        await persistence.flushed();
        expect(
            records
                .keys()
                .toArray()
                .toSorted((left, right) => left.localeCompare(right)),
        ).toEqual(['chat-b', 'chat-c']);

        const smaller = createAgentChatAttachmentPersistence({ backend, limit: size });
        await expect(smaller.hydrate()).resolves.toEqual(new Map([['chat-c', [attachment('c')]]]));
        await smaller.flushed();
        expect(records.keys().toArray()).toEqual(['chat-c']);
    });

    it("keeps this run's images for a Chat changed before the restore finished", async () => {
        const { backend } = memoryBackend([
            { terminalId: 'chat-a', attachments: [attachment('old')], updatedAt: 1 },
            { terminalId: 'chat-b', attachments: [attachment('b')], updatedAt: 1 },
        ]);
        const persistence = createAgentChatAttachmentPersistence({ backend });
        // The user removed chat-a's images in this run before the store was read.
        persistence.save('chat-a', []);
        await expect(persistence.hydrate()).resolves.toEqual(
            new Map([['chat-b', [attachment('b')]]]),
        );
    });

    it('deletes the images of Chats the Workbench no longer has, even before the restore', async () => {
        const { backend, records } = memoryBackend([
            { terminalId: 'chat-a', attachments: [attachment('a')], updatedAt: 1 },
            { terminalId: 'gone', attachments: [attachment('g')], updatedAt: 1 },
        ]);
        const persistence = createAgentChatAttachmentPersistence({ backend });
        persistence.retain(new Set(['chat-a']));
        await expect(persistence.hydrate()).resolves.toEqual(
            new Map([['chat-a', [attachment('a')]]]),
        );
        persistence.save('chat-b', [attachment('b')]);
        persistence.retain(new Set(['chat-a']));
        await persistence.flushed();
        expect(records.keys().toArray()).toEqual(['chat-a']);
    });

    it('restores nothing and keeps working when the store cannot be read or written', async () => {
        const persistence = createAgentChatAttachmentPersistence({
            backend: {
                readAll: () => Promise.reject(new Error('blocked')),
                put: () => Promise.reject(new Error('quota')),
                delete: () => Promise.reject(new Error('blocked')),
            },
        });
        persistence.save('chat-a', [attachment('a')]);
        await expect(persistence.hydrate()).resolves.toEqual(new Map());
        await expect(persistence.flushed()).resolves.toBeUndefined();
    });
});
