import { parseProcessTable, ProcessTable } from '@caxri/system';
import { describe, expect, it } from 'vitest';

import { aggregateTerminalResources } from '../resources';

describe('Terminal resource sampling', () => {
    it('sums the PTY process tree and excludes the root from the child count', () => {
        const table = new ProcessTable(
            parseProcessTable(`
            100 1 0.5 1024
            101 100 120.0 2048
            102 101 3.2 512
            200 1 99.0 9999
        `),
        );

        expect(aggregateTerminalResources(100, table)).toEqual({
            cpuPercent: 123.7,
            memoryMb: 3.5,
            childProcessCount: 2,
        });
    });

    it('returns no usage after the root process has exited', () => {
        const table = new ProcessTable(parseProcessTable('100 1 0.0 1024'));
        expect(aggregateTerminalResources(999, table)).toBeNull();
    });
});
