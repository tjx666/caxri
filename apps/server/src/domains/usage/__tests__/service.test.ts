import { describe, expect, it } from 'vitest';

import { reportedPendingScans } from '../service';

describe('reportedPendingScans', () => {
    it('reports a scan still discovering transcripts as pending', () => {
        expect(reportedPendingScans(true, 0)).toBe(1);
        expect(reportedPendingScans(true, 40)).toBe(40);
    });

    it('reports nothing pending once the scan finished', () => {
        expect(reportedPendingScans(false, 3)).toBe(0);
    });
});
