import type { AgentChatSnapshot, AgentTimelineItem } from '@caxri/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
    cachedChatSchema,
    cachedTimelineSchema,
    decodeReadCacheEntry,
    encodeReadCacheEntry,
    liveReadSaveScope,
    READ_CACHE_MAX_CONVERSATIONS,
    READ_CACHE_MAX_ITEMS,
    readCacheFileName,
    trimChatSnapshot,
    trimTimelineItems,
} from '../read-cache-model';
import type { ReadCacheFiles } from '../read-cache-store';
import { createReadCache, READ_CACHE_WRITE_DELAY_MS } from '../read-cache-store';

const scope = JSON.stringify(['host-1', 'device-1', 1]);

const memoryFiles = () => {
    const files = new Map<string, { modifiedAt: number; text: string }>();
    let clock = 0;
    const backend: ReadCacheFiles = {
        clear: () => files.clear(),
        list: () => [...files].map(([name, file]) => ({ name, modifiedAt: file.modifiedAt })),
        read: (name) => Promise.resolve(files.get(name)?.text ?? null),
        remove: (name) => {
            files.delete(name);
        },
        write: (name, text) => {
            clock += 1;
            files.set(name, { modifiedAt: clock, text });
        },
    };
    return { backend, files };
};

const chat = (items: AgentChatSnapshot['items']): AgentChatSnapshot => ({
    terminalId: 'terminal-1',
    revision: 7,
    status: 'ready',
    truncated: false,
    items,
    turns: [
        { id: 't1', status: 'completed' },
        { id: 't2', status: 'completed' },
    ],
    requests: [
        {
            id: 'request-1',
            turnId: 't2',
            kind: 'question',
            questions: [{ id: 'q1', header: 'Pick', question: 'Which?', options: [] }],
        } as unknown as AgentChatSnapshot['requests'][number],
    ],
    model: 'opus',
    models: [
        { id: 'opus', displayName: 'Opus', efforts: ['high'], defaultEffort: 'high' },
        { id: 'sonnet', displayName: 'Sonnet', efforts: [] },
    ],
});

describe('read cache model', () => {
    it('keeps only what a reader recognizes the work by, never output, diffs, or image previews', () => {
        const trimmed = trimChatSnapshot(
            chat([
                {
                    id: 'u1',
                    turnId: 't1',
                    type: 'userMessage',
                    text: 'Look at this',
                    images: [{ mediaType: 'image/png', preview: 'data' } as never],
                },
                {
                    id: 'c1',
                    turnId: 't2',
                    type: 'command',
                    command: 'pnpm test',
                    output: 'secret output',
                    status: 'completed',
                },
                {
                    id: 'f1',
                    turnId: 't2',
                    type: 'fileChange',
                    status: 'completed',
                    changes: [{ path: 'src/a.ts', kind: 'update', diff: '+source line' }],
                },
                {
                    id: 'x1',
                    turnId: 't2',
                    type: 'toolCall',
                    name: 'webSearch',
                    status: 'completed',
                    summary: 'caxri',
                    output: 'result body',
                },
            ]),
        );
        expect(JSON.stringify(trimmed)).not.toMatch(/secret output|source line|result body|"data"/);
        expect(trimmed.items[0]).toMatchObject({ text: 'Look at this', images: [{}] });
        expect(trimmed.items[1]).toMatchObject({ command: 'pnpm test', output: '' });
        expect(trimmed.items[3]).toMatchObject({ name: 'webSearch', summary: 'caxri' });
        expect(trimmed.requests).toEqual([]);
        expect(trimmed.model).toBe('opus');
        expect(trimmed.models?.map((model) => model.displayName)).toEqual(['Opus']);
        expect(cachedChatSchema.safeParse(trimmed).success).toBe(true);
    });

    it('keeps the newest messages of a long Chat and says the rest were cut', () => {
        const items = Array.from({ length: READ_CACHE_MAX_ITEMS + 5 }, (_, index) => ({
            id: `a${index}`,
            turnId: index < 10 ? 't1' : 't2',
            type: 'agentMessage' as const,
            text: `reply ${index}`,
            streaming: false,
        }));
        const trimmed = trimChatSnapshot(chat(items));
        expect(trimmed.items).toHaveLength(READ_CACHE_MAX_ITEMS);
        expect(trimmed.items[0]?.id).toBe('a5');
        expect(trimmed.truncated).toBe(true);
        expect(trimmed.turns.map((turn) => turn.id)).toEqual(['t1', 't2']);
    });

    it('drops tool and system details from a saved Conversation', () => {
        const items = [
            { id: 'm1', type: 'userMessage', text: 'hi' },
            {
                id: 't1',
                type: 'toolCall',
                name: 'Bash',
                status: 'succeeded',
                summary: 'ls',
                detail: { kind: 'text', text: 'Terminal output' },
            },
        ] as unknown as AgentTimelineItem[];
        const trimmed = trimTimelineItems(items);
        expect(JSON.stringify(trimmed)).not.toContain('Terminal output');
        expect(trimmed[1]).toMatchObject({ summary: 'ls' });
    });

    it('reads an entry only back under the pairing that wrote it', () => {
        const text = encodeReadCacheEntry(scope, 10, { items: [], truncated: false });
        expect(decodeReadCacheEntry(text, scope, cachedTimelineSchema)).toEqual({
            savedAt: 10,
            value: { items: [], truncated: false },
        });
        const repaired = JSON.stringify(['host-1', 'device-1', 2]);
        expect(decodeReadCacheEntry(text, repaired, cachedTimelineSchema)).toBeNull();
        expect(decodeReadCacheEntry('{not json', scope, cachedTimelineSchema)).toBeNull();
        expect(
            decodeReadCacheEntry(
                text.replace('"version":1', '"version":0'),
                scope,
                cachedTimelineSchema,
            ),
        ).toBeNull();
        expect(
            decodeReadCacheEntry(
                encodeReadCacheEntry(scope, 10, { items: 'nope' }),
                scope,
                cachedTimelineSchema,
            ),
        ).toBeNull();
    });
});

describe('live read save scope', () => {
    const next = JSON.stringify(['host-2', 'device-2', 1]);

    it('saves a live read under the pairing it was read under while that pairing is current', () => {
        expect(liveReadSaveScope(scope, scope)).toBe(scope);
    });

    it('never saves a read from the previous pairing under the new scope, or without a pairing', () => {
        expect(liveReadSaveScope(scope, next)).toBeNull();
        expect(liveReadSaveScope(scope, null)).toBeNull();
        expect(liveReadSaveScope(undefined, next)).toBeNull();
    });
});

describe('read cache store', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });
    afterEach(() => {
        vi.useRealTimers();
    });

    it('writes once per pause and reads the latest value back', async () => {
        const { backend, files } = memoryFiles();
        const write = vi.spyOn(backend, 'write');
        const cache = createReadCache(backend, () => 42);
        cache.setScope(scope);
        const key = { kind: 'timeline', sessionId: 'session/1' } as const;
        cache.save(scope, key, { items: [], truncated: false });
        cache.save(scope, key, { items: [], truncated: true });
        expect(write).not.toHaveBeenCalled();
        vi.advanceTimersByTime(READ_CACHE_WRITE_DELAY_MS);
        expect(write).toHaveBeenCalledTimes(1);
        expect(files.keys().toArray()).toEqual([readCacheFileName(key)]);
        await expect(cache.load(scope, key, cachedTimelineSchema)).resolves.toEqual({
            savedAt: 42,
            value: { items: [], truncated: true },
        });
    });

    it('writes pending entries at once when the app leaves the foreground', () => {
        const { backend, files } = memoryFiles();
        const cache = createReadCache(backend);
        cache.setScope(scope);
        cache.save(scope, { kind: 'dashboard' }, {});
        cache.flush();
        expect(files.has('dashboard.json')).toBe(true);
    });

    it('never writes back a forgotten pairing after clear', async () => {
        const { backend, files } = memoryFiles();
        const cache = createReadCache(backend);
        cache.setScope(scope);
        cache.save(scope, { kind: 'dashboard' }, {});
        cache.flush();
        cache.save(scope, { kind: 'chat', terminalId: 'terminal-1' }, {});
        cache.clear();
        vi.advanceTimersByTime(READ_CACHE_WRITE_DELAY_MS);
        cache.flush();
        expect(files.size).toBe(0);
        await expect(cache.load(scope, { kind: 'dashboard' }, cachedTimelineSchema)).resolves.toBe(
            null,
        );
    });

    it('keeps only the most recently saved Conversations and Chats', () => {
        const { backend, files } = memoryFiles();
        const cache = createReadCache(backend);
        cache.setScope(scope);
        cache.save(scope, { kind: 'dashboard' }, {});
        for (let index = 0; index <= READ_CACHE_MAX_CONVERSATIONS; index += 1) {
            cache.save(scope, { kind: 'timeline', sessionId: `s${index}` }, {});
            cache.flush();
        }
        expect(files.has('dashboard.json')).toBe(true);
        expect(files.has('timeline-s0.json')).toBe(false);
        expect(files.has(`timeline-s${READ_CACHE_MAX_CONVERSATIONS}.json`)).toBe(true);
        expect(files.size).toBe(READ_CACHE_MAX_CONVERSATIONS + 1);
    });

    it('treats an unreadable or failing disk as a miss', async () => {
        const { backend } = memoryFiles();
        const cache = createReadCache({
            ...backend,
            read: () => Promise.reject(new Error('io')),
            write: () => {
                throw new Error('full');
                cache.setScope(scope);
            },
        });
        cache.save(scope, { kind: 'dashboard' }, {});
        expect(() => cache.flush()).not.toThrow();
        await expect(cache.load(scope, { kind: 'dashboard' }, cachedTimelineSchema)).resolves.toBe(
            null,
        );
    });

    it('drops a write whose pairing stopped being current before it flushed', () => {
        const { backend, files } = memoryFiles();
        const cache = createReadCache(backend);
        cache.setScope(scope);
        cache.save(scope, { kind: 'chat', terminalId: 'terminal-1' }, {});
        cache.setScope(JSON.stringify(['host-2', 'device-2', 1]));
        vi.advanceTimersByTime(READ_CACHE_WRITE_DELAY_MS);
        cache.save(scope, { kind: 'dashboard' }, {});
        cache.flush();
        expect(files.size).toBe(0);
    });

    it('writes nothing while unpaired', () => {
        const { backend, files } = memoryFiles();
        const cache = createReadCache(backend);
        cache.save(scope, { kind: 'dashboard' }, {});
        cache.flush();
        expect(files.size).toBe(0);
    });
});
