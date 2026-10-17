import { describe, expect, it, vi } from 'vitest';

import type {
    AgentChatAttachmentBackend,
    PersistedAgentChatAttachmentRecord,
} from '../agent-chat-attachment-persistence';
import type { AgentChatDraftStash } from '../agent-chat-draft-stash';
import {
    agentChatDraftStashDatabaseName,
    createAgentChatDraftStashStore,
} from '../agent-chat-draft-stash';

function storage() {
    const records = new Map<string, PersistedAgentChatAttachmentRecord>();
    const backend: AgentChatAttachmentBackend = {
        readAll: vi.fn(() =>
            Promise.resolve(
                records
                    .values()
                    .map((record) => structuredClone(record))
                    .toArray(),
            ),
        ),
        put: vi.fn((record: PersistedAgentChatAttachmentRecord) => {
            records.set(record.terminalId, structuredClone(record));
            return Promise.resolve();
        }),
        delete: vi.fn((terminalId: string) => {
            records.delete(terminalId);
            return Promise.resolve();
        }),
    };
    return { backend, records };
}

const draft: AgentChatDraftStash = {
    text: 'First draft line\nSecond draft line\n/work/example/paste.txt',
    selectionStart: 4,
    selectionEnd: 9,
    selectionDirection: 'backward',
    isGoalMode: true,
    attachments: [
        { id: 'file', path: '/work/example/example.md', isDirectory: false },
        {
            id: 'image',
            image: {
                mediaType: 'image/png',
                data: 'AAAA',
                thumbnail: 'data:image/jpeg;base64,AAAA',
            },
            name: 'example.png',
        },
    ],
};

describe('Agent Chat draft stash', () => {
    it('restores the entire checkpoint after a restart, independently for each Chat', async () => {
        const { backend } = storage();
        const first = createAgentChatDraftStashStore({ backend });
        await first.save('chat-a', draft);
        await first.save('chat-b', { ...draft, text: 'another draft' });
        const restarted = createAgentChatDraftStashStore({ backend });
        expect(await restarted.read('chat-a')).toEqual(draft);
        expect((await restarted.read('chat-b'))?.text).toBe('another draft');
        expect(await restarted.read('chat-a')).toEqual(draft);
        expect(await restarted.read('missing-chat')).toBeUndefined();
    });

    it('keeps the previous checkpoint when replacing it fails to commit', async () => {
        const { backend } = storage();
        const store = createAgentChatDraftStashStore({ backend });
        await store.save('chat-a', draft);
        vi.mocked(backend.put).mockRejectedValueOnce(new Error('Example transaction failure'));
        await expect(store.save('chat-a', { ...draft, text: 'replacement' })).rejects.toThrow(
            'Example transaction failure',
        );
        expect(await store.read('chat-a')).toEqual(draft);
    });

    it('does not report a successful save until the complete record commits', async () => {
        const { backend, records } = storage();
        const gate = Promise.withResolvers<void>();
        vi.mocked(backend.put).mockImplementationOnce(async (record) => {
            await gate.promise;
            records.set(record.terminalId, structuredClone(record));
        });
        const store = createAgentChatDraftStashStore({ backend });
        let isCommitted = false;
        const saved = (async () => {
            await store.save('chat-a', draft);
            isCommitted = true;
        })();
        await vi.waitFor(() => expect(backend.put).toHaveBeenCalledOnce());
        expect(isCommitted).toBe(false);
        expect(records.has('chat-a')).toBe(false);
        gate.resolve();
        await saved;
        expect(isCommitted).toBe(true);
        expect(await store.read('chat-a')).toEqual(draft);
    });

    it('evicts older Chats by count while retaining the newly committed checkpoint', async () => {
        const { backend, records } = storage();
        let clock = 0;
        const store = createAgentChatDraftStashStore({
            backend,
            countLimit: 2,
            now: () => ++clock,
        });
        await store.save('chat-a', draft);
        await store.save('chat-b', draft);
        await store.save('chat-c', draft);
        expect(await store.read('chat-a')).toBeUndefined();
        expect(await store.read('chat-c')).toEqual(draft);
        expect(records.size).toBe(2);
    });

    it('does not destroy a saved checkpoint when a replacement exceeds the budget', async () => {
        const { backend } = storage();
        const store = createAgentChatDraftStashStore({ backend, limit: 256 });
        await store.save('chat-a', draft);
        await expect(store.save('chat-a', { ...draft, text: 'x'.repeat(512) })).rejects.toThrow(
            'too large',
        );
        expect(await store.read('chat-a')).toEqual(draft);
    });

    it('isolates the workbench, Commander and resolved SSH environment databases', () => {
        expect(
            new Set(['local', 'commander', 'ssh:example-host'].map(agentChatDraftStashDatabaseName))
                .size,
        ).toBe(3);
    });
});
