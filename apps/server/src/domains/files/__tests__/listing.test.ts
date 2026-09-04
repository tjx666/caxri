import { Buffer } from 'node:buffer';

import type { FileEntry } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

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
        const probeTarget = createSymlinkTargetProbe(10);
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

    it('reports a symlink without link metadata rather than guessing when the probe answers nothing', async () => {
        const entry = await describeSymlink('/root/stalled', 'stalled', async () => {});

        // Not `broken`: an unanswered probe means unknown, and the Renderer falls back to the neutral icon.
        expect(entry).toEqual({ kind: 'symlink', name: 'stalled', path: '/root/stalled' });
    });
});
