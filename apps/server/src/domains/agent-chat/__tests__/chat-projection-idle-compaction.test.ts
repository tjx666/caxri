import type { StructuredLogger } from '@caxri/system';
import { describe, expect, it, vi } from 'vitest';

import { ChatProjection } from '../chat-projection';

const logger = { write: () => {} } as unknown as StructuredLogger;

describe('ChatProjection noteIdleCompaction', () => {
    function projection() {
        return new ChatProjection({
            terminalId: 'terminal-1',
            revision: 0,
            taskRevisionFloors: new Map(),
            logger,
            send: () => {},
            onChange: () => {},
            onTasksChanged: () => {},
            delegatedTask: () => ({}),
        });
    }
    const compacted = (id: string, trigger: 'auto' | 'manual') =>
        ({
            op: 'upsertItem',
            item: {
                id,
                type: 'notice',
                kind: 'compacted',
                compaction: { beforeTokens: 9, trigger },
            },
        }) as const;

    it('labels the next compacted notice idle, and only that one', () => {
        const chat = projection();
        chat.noteIdleCompaction();
        chat.apply([compacted('n1', 'manual')]);
        chat.apply([compacted('n2', 'manual')]);
        expect(
            chat.snapshot.items.map((item) => item.type === 'notice' && item.compaction),
        ).toEqual([
            { beforeTokens: 9, trigger: 'idle' },
            { beforeTokens: 9, trigger: 'manual' },
        ]);
    });

    it('labels nothing once the provider refused the idle compaction', () => {
        const chat = projection();
        chat.noteIdleCompaction();
        chat.forgetIdleCompaction();
        chat.apply([compacted('n1', 'auto')]);
        expect(chat.snapshot.items[0]).toMatchObject({ compaction: { trigger: 'auto' } });
    });

    it('stops labeling once its window passed without a compaction', () => {
        vi.useFakeTimers({ now: 0 });
        try {
            const chat = projection();
            chat.noteIdleCompaction();
            vi.setSystemTime(10 * 60_000 + 1);
            chat.apply([compacted('n1', 'manual')]);
            expect(chat.snapshot.items[0]).toMatchObject({ compaction: { trigger: 'manual' } });
        } finally {
            vi.useRealTimers();
        }
    });
});
