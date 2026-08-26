import { describe, expect, it } from 'vitest';

import { aggregateTerminalResources, parseProcessResourceEntries } from '../resources';

describe('Terminal resource sampling', () => {
    it('sums the PTY process tree and excludes the root from the child count', () => {
        const entries = parseProcessResourceEntries(`
            100 1 1024
            101 100 2048
            102 101 512
            200 1 9999
        `);

        expect(aggregateTerminalResources(100, entries)).toEqual({
            memoryMb: 3.5,
            childProcessCount: 2,
        });
    });

    it('returns no usage after the root process has exited', () => {
        expect(
            aggregateTerminalResources(999, parseProcessResourceEntries('100 1 1024')),
        ).toBeNull();
    });
});
