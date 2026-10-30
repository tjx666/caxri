import type { AgentChatItem } from '@caxri/protocol';
import { MAX_AGENT_CHAT_TASK_ITEMS } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import { ChatTaskProjections } from '../projections';

function message(index: number): AgentChatItem {
    return { id: `m${index}`, type: 'agentMessage', text: `Message ${index}`, streaming: false };
}

function projections(): ChatTaskProjections {
    return new ChatTaskProjections(
        'terminal-1',
        new Map(),
        () => [],
        () => {},
    );
}

function fill(tasks: ChatTaskProjections, count: number): void {
    tasks.apply(
        'task-1',
        Array.from({ length: count }, (_, index) => ({
            op: 'upsertItem' as const,
            item: message(index),
        })),
    );
}

describe('task history paging', () => {
    it('pages back from the first live item to the first item of a task longer than its projection', () => {
        const tasks = projections();
        const total = MAX_AGENT_CHAT_TASK_ITEMS + 120;
        fill(tasks, total);
        const live = tasks.get('task-1')!;
        expect(live.items).toHaveLength(MAX_AGENT_CHAT_TASK_ITEMS);
        expect(live.truncated).toBe(true);

        const seen: string[] = [];
        let cursor = live.items[0].id;
        for (let pages = 0; pages < 20; pages += 1) {
            const page = tasks.readHistoryPage('task-1', cursor)!;
            expect(page.historyId).toBe('task-1');
            seen.unshift(...page.items.map((item) => item.id));
            if (!page.hasMore) {
                expect(page.truncated).toBe(false);
                break;
            }
            cursor = page.items[0].id;
        }
        expect(seen).toHaveLength(120);
        expect(seen[0]).toBe('m0');
        expect(seen.at(-1)).toBe(`m119`);
    });

    it('returns an empty page for an unknown cursor and nothing for an unknown task', () => {
        const tasks = projections();
        fill(tasks, MAX_AGENT_CHAT_TASK_ITEMS + 5);
        expect(tasks.readHistoryPage('task-1', 'missing')).toMatchObject({
            items: [],
            hasMore: false,
        });
        expect(tasks.readHistoryPage('other', 'm1')).toBeUndefined();
    });

    it('forgets the archive when the task is reset', () => {
        const tasks = projections();
        fill(tasks, MAX_AGENT_CHAT_TASK_ITEMS + 5);
        tasks.apply('task-1', [{ op: 'reset' }]);
        fill(tasks, 3);
        const page = tasks.readHistoryPage('task-1', 'm0')!;
        expect(page.items).toEqual([]);
        expect(page.hasMore).toBe(false);
    });

    it('ends truncated when the provider reported a cut-off record', () => {
        const tasks = projections();
        tasks.apply('task-1', [
            ...Array.from({ length: MAX_AGENT_CHAT_TASK_ITEMS + 2 }, (_, index) => ({
                op: 'upsertItem' as const,
                item: message(index),
            })),
            { op: 'state', state: { truncated: true } },
        ]);
        const first = tasks.readHistoryPage('task-1', tasks.get('task-1')!.items[0].id)!;
        expect(first.items.map((item) => item.id)).toEqual(['m0', 'm1']);
        expect(first.hasMore).toBe(true);
        const last = tasks.readHistoryPage('task-1', 'm0')!;
        expect(last).toMatchObject({ items: [], hasMore: false, truncated: true });
    });
});
