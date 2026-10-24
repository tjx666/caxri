import { Buffer } from 'node:buffer';

import type { FileEntry } from '@caxri/protocol';
import { describe, expect, it, vi } from 'vitest';

import {
    boundFileListEntries,
    compareFileEntries,
    createSymlinkTargetProbe,
    describeSymlink,
    MAX_FILE_LIST_RESULT_BYTES,
} from '../listing';

describe('directory listing helpers', () => {
    it('keeps the serialized directory page below its transport byte budget', () => {
        const entries = Array.from({ length: 1_024 }, (_unused, index) => ({
            kind: 'file' as const,
            name: `entry-${index}.txt`,
            path: `/${'deep/'.repeat(700)}entry-${index}.txt`,
        }));

        const bounded = boundFileListEntries(entries);

        expect(bounded.length).toBeLessThan(entries.length);
        expect(
            Buffer.byteLength(JSON.stringify({ entries: bounded, truncated: true }), 'utf8'),
        ).toBeLessThanOrEqual(MAX_FILE_LIST_RESULT_BYTES);
    });

    it('orders entries independently of the order the filesystem reported them', () => {
        const entries: FileEntry[] = [
            { kind: 'file', name: 'b.ts', path: '/root/b.ts' },
            { kind: 'symlink', linkKind: 'directory', name: 'a-link', path: '/root/a-link' },
            { kind: 'file', name: 'a.ts', path: '/root/a.ts' },
            { kind: 'directory', name: 'z-dir', path: '/root/z-dir' },
            { kind: 'symlink', linkKind: 'file', name: 'c-link', path: '/root/c-link' },
        ];

        const sorted = entries.toSorted(compareFileEntries).map((entry) => entry.name);

        expect(sorted).toEqual(['a-link', 'z-dir', 'a.ts', 'b.ts', 'c-link']);
        expect(
            entries
                .toReversed()
                .toSorted(compareFileEntries)
                .map((entry) => entry.name),
        ).toEqual(sorted);
        // The comparator must be antisymmetric; the previous `kind`-pair form answered `1` both ways.
        for (const a of entries)
            for (const b of entries)
                expect(
                    Math.sign(compareFileEntries(a, b)) + Math.sign(compareFileEntries(b, a)),
                ).toBe(0);
    });

    it('stops probing symlink targets once one outlives the listing budget', async () => {
        const probeTarget = createSymlinkTargetProbe({ timeoutMs: 10 });
        // A target on an unresponsive mount blocks `fs.stat` indefinitely and cannot be cancelled.
        const hung = new Promise<never>(() => {});
        const attempted: string[] = [];

        const first = await probeTarget(() => {
            attempted.push('first');
            return hung;
        });
        const second = await probeTarget(() => {
            attempted.push('second');
            return Promise.resolve('healthy');
        });

        expect(first).toBeUndefined();
        // The budget is spent, so the listing stops issuing follows that could pin more threadpool threads.
        expect(second).toBeUndefined();
        expect(attempted).toEqual(['first']);
    });

    /**
     * The slow-but-alive mount, which is the case the per-probe timeout could never catch: at 200ms a target never
     * reaches a 2s ceiling, so before the cumulative budget existed every keystroke in the Cmd+P path input re-issued
     * the full round of uncancellable follows.
     */
    it('closes the budget once the probes it allowed have waited long enough in total', async () => {
        // Fake clock: on a loaded runner a real 20ms timer can fire after 30ms, spending the budget on the first probe.
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
        try {
            const spent: Array<{ reason: string; waitedMs: number }> = [];
            const probeTarget = createSymlinkTargetProbe({
                budgetMs: 30,
                onBudgetSpent: (reason, waitedMs) => spent.push({ reason, waitedMs }),
                timeoutMs: 10_000,
            });
            const slow = async <T>(value: T) => {
                const answer = probeTarget(
                    () => new Promise<T>((resolve) => setTimeout(() => resolve(value), 20)),
                );
                await vi.advanceTimersByTimeAsync(20);
                return answer;
            };

            const first = await slow('first');
            const second = await slow('second');
            const third = await slow('third');

            // Both answered: the budget bounds what a listing spends, it does not discard work already paid for.
            expect([first, second]).toEqual(['first', 'second']);
            expect(third).toBeUndefined();
            expect(spent).toEqual([{ reason: 'cumulative_wait', waitedMs: 40 }]);
        } finally {
            vi.useRealTimers();
        }
    });

    it('names a hung target apart from a merely slow one, and reports it once', async () => {
        const spent: string[] = [];
        const probeTarget = createSymlinkTargetProbe({
            onBudgetSpent: (reason) => spent.push(reason),
            timeoutMs: 10,
        });
        const hung = new Promise<never>(() => {});

        await probeTarget(() => hung);
        await probeTarget(() => hung);

        // One listing spends its budget once; the second follow is refused, not re-reported.
        expect(spent).toEqual(['probe_timeout']);
    });

    it('leaves the budget open, and silent, for a listing whose targets answer promptly', async () => {
        const spent: string[] = [];
        const probeTarget = createSymlinkTargetProbe({
            budgetMs: 1_000,
            onBudgetSpent: (reason) => spent.push(reason),
        });

        expect(await probeTarget(() => Promise.resolve('a'))).toBe('a');
        expect(await probeTarget(() => Promise.resolve('b'))).toBe('b');
        expect(spent).toEqual([]);
    });

    it('reports a symlink without link metadata rather than guessing when the probe answers nothing', async () => {
        const entry = await describeSymlink('/root/stalled', 'stalled', async () => {});

        // Not `broken`: an unanswered probe means unknown, and the Renderer falls back to the neutral icon.
        expect(entry).toEqual({ kind: 'symlink', name: 'stalled', path: '/root/stalled' });
    });
});
