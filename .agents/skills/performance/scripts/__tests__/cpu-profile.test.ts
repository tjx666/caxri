import { describe, expect, it } from 'vitest';

import type { CpuProfileNode } from '../cpu-profile';
import { summarizeCpuProfile } from '../cpu-profile';

function node(id: number, functionName: string, children: number[] = []): CpuProfileNode {
    return {
        id,
        callFrame: {
            functionName,
            url: functionName ? 'file:///bundle/server-core.js' : '',
            lineNumber: id,
        },
        children,
    };
}

describe('summarizeCpuProfile', () => {
    it('separates idle time and attributes each sample once to every distinct ancestor', () => {
        const summary = summarizeCpuProfile({
            nodes: [
                node(1, '(root)', [2, 3]),
                node(2, '(idle)'),
                node(3, 'reconcile', [4]),
                node(4, 'parse', [5]),
                node(5, 'parse'),
            ],
            samples: [2, 2, 5, 4],
        });

        expect(summary.busyPercent).toBe(50);
        expect(summary.self[0]).toEqual({ frame: '(idle) server-core.js:3', percent: 50 });
        // `parse` recurses, but a sample counts once per distinct function up its stack.
        expect(summary.inclusive).toEqual(
            expect.arrayContaining([
                { name: 'reconcile', percent: 50 },
                { name: 'parse', percent: 50 },
            ]),
        );
    });
});
