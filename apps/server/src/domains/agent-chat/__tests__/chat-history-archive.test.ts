import type { AgentChatItem } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import { ChatHistoryArchive } from '../chat-history-archive';

function command(id: string, output: string): AgentChatItem {
    return { id, type: 'command', command: 'pnpm test', status: 'completed', output, turnId: 't1' };
}

function message(id: string, text: string): AgentChatItem {
    return { id, type: 'agentMessage', text, streaming: false, turnId: 't1' };
}

describe('ChatHistoryArchive', () => {
    it('pages large archived items back exactly as they were evicted', () => {
        const archive = new ChatHistoryArchive();
        // Non-Latin-1 text forces V8's two-byte representation, the case that made archived output expensive.
        const output = `${'✓ passes 测试\n'.repeat(1200)}done`;
        const items = [
            command('a', output),
            message('b', 'short reply'),
            command('c', 'x'.repeat(4096)),
        ];
        const live = message('d', 'live');
        archive.recordEviction(
            { items: [...items, live], turns: [{ id: 't1', status: 'completed', startedAt: 1 }] },
            { items: [live] },
        );

        const page = archive.page('d', 'd');
        expect(page?.items).toEqual(items);
        expect(page?.turns.map((turn) => turn.id)).toEqual(['t1']);
        expect(page?.hasMore).toBe(false);
        expect(archive.page('b', 'd')?.items).toEqual([items[0]]);
    });

    it('keeps large items compressed and charges the budget by their uncompressed text', () => {
        const output = 'npm warn deprecated package@1.0.0\n'.repeat(400);
        const archive = new ChatHistoryArchive({
            maxItems: 100,
            maxTextLength: output.length * 2 + 50,
        });
        const live = message('live', 'live');
        archive.recordEviction(
            { items: [command('a', output), command('b', output), command('c', output), live] },
            { items: [live] },
        );

        const entries = (
            archive as unknown as {
                items: Array<{ id: string; item?: unknown; packed?: Uint8Array }>;
            }
        ).items;
        // Three outputs exceed a two-output budget, so the oldest goes even though all three compress far below it.
        expect(entries.map((entry) => entry.id)).toEqual(['b', 'c']);
        expect(archive.isIncomplete).toBe(true);
        for (const entry of entries) {
            expect(entry.item).toBeUndefined();
            expect(entry.packed!.byteLength).toBeLessThan(output.length / 10);
            // A slice of zlib's pooled buffer would pin 64 KiB per item.
            expect(entry.packed!.buffer.byteLength).toBe(entry.packed!.byteLength);
        }
    });
});
