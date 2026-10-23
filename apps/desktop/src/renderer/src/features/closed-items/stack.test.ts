import { describe, expect, it } from 'vitest';

import type { ClosedItem } from './stack';
import { createClosedItemStack, isRecordableTabPath } from './stack';

const tab = (sessionId: string, path: string, index = 0): ClosedItem => ({
    kind: 'tab',
    sessionId,
    paneId: 'pane-1',
    index,
    path,
});
const session = (sessionId: string): ClosedItem => ({ kind: 'session', sessionId });

describe('closed item stack', () => {
    it('reopens the newest entry first and walks further back on each call', async () => {
        const stack = createClosedItemStack();
        stack.push([tab('s1', 'a.ts'), session('s2')]);
        const reopened: ClosedItem[] = [];
        const accept = (item: ClosedItem) => {
            reopened.push(item);
            return Promise.resolve(true);
        };
        await stack.reopenNext(accept);
        await stack.reopenNext(accept);
        expect(reopened).toEqual([session('s2'), tab('s1', 'a.ts')]);
        expect(await stack.reopenNext(accept)).toBeUndefined();
    });

    it('reopens a bulk close from its last tab back to its first', async () => {
        const stack = createClosedItemStack();
        stack.push([tab('s1', 'a.ts', 0), tab('s1', 'b.ts', 1), tab('s1', 'c.ts', 2)]);
        expect((await stack.reopenNext(() => Promise.resolve(true)))?.kind).toBe('tab');
        expect(stack.snapshot().map((item) => (item.kind === 'tab' ? item.path : ''))).toEqual([
            'b.ts',
            'a.ts',
        ]);
    });

    it('skips and discards entries that can no longer be reopened', async () => {
        const stack = createClosedItemStack();
        stack.push([tab('s1', 'gone.ts'), session('deleted'), tab('s1', 'ok.ts')]);
        const tried: string[] = [];
        const reopened = await stack.reopenNext((item) => {
            tried.push(item.kind === 'tab' ? item.path : item.sessionId);
            return Promise.resolve(item.kind === 'tab' && item.path === 'gone.ts');
        });
        expect(tried).toEqual(['ok.ts', 'deleted', 'gone.ts']);
        expect(reopened).toEqual(tab('s1', 'gone.ts'));
        expect(stack.snapshot()).toEqual([]);
    });

    it('replaces an older entry for the same tab or Session instead of duplicating it', () => {
        const stack = createClosedItemStack();
        for (const batch of [
            [tab('s1', 'a.ts', 3), session('s1'), tab('s2', 'a.ts')],
            [tab('s1', 'a.ts', 0), session('s1')],
        ])
            stack.push(batch);
        expect(stack.snapshot()).toEqual([session('s1'), tab('s1', 'a.ts', 0), tab('s2', 'a.ts')]);
    });

    it('bounds the history, dropping the oldest entries', () => {
        const stack = createClosedItemStack(3);
        stack.push([1, 2, 3, 4, 5].map((n) => tab('s1', `${n}.ts`)));
        expect(stack.snapshot().map((item) => (item.kind === 'tab' ? item.path : ''))).toEqual([
            '5.ts',
            '4.ts',
            '3.ts',
        ]);
    });

    it('forgets every entry of a deleted Session', () => {
        const stack = createClosedItemStack();
        stack.push([tab('s1', 'a.ts'), session('s1'), tab('s2', 'b.ts')]);
        stack.forgetSessions(['s1']);
        expect(stack.snapshot()).toEqual([tab('s2', 'b.ts')]);
    });

    it('shares one walk between overlapping calls so a held key reopens one entry', async () => {
        const stack = createClosedItemStack();
        stack.push([tab('s1', 'a.ts'), tab('s1', 'b.ts')]);
        let calls = 0;
        const slow = () => {
            calls += 1;
            return Promise.resolve(true);
        };
        const [first, second] = await Promise.all([stack.reopenNext(slow), stack.reopenNext(slow)]);
        expect(first).toBe(second);
        expect(calls).toBe(1);
        expect(stack.snapshot()).toHaveLength(1);
    });

    it('never records untitled editor tabs', () => {
        expect(isRecordableTabPath('caxri-untitled://1')).toBe(false);
        expect(isRecordableTabPath('src/index.ts')).toBe(true);
    });
});
