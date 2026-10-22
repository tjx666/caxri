import { describe, expect, it } from 'vitest';

import { createSaveFailureTracker } from '../save-failure-tracker';

describe('createSaveFailureTracker', () => {
    it('reports a repeated auto save failure for one file and reason only once', () => {
        const tracker = createSaveFailureTracker();
        expect(tracker.shouldReport('s\0a.ts', 'Read-only.')).toBe(true);
        expect(tracker.shouldReport('s\0a.ts', 'Read-only.')).toBe(false);
    });

    it('reports a different file and a different reason separately', () => {
        const tracker = createSaveFailureTracker();
        tracker.shouldReport('s\0a.ts', 'Read-only.');
        expect(tracker.shouldReport('s\0b.ts', 'Read-only.')).toBe(true);
        expect(tracker.shouldReport('s\0a.ts', 'Disk full.')).toBe(true);
    });

    it('reports again after a successful save clears the file', () => {
        const tracker = createSaveFailureTracker();
        tracker.shouldReport('s\0a.ts', 'Read-only.');
        tracker.clear('s\0a.ts');
        expect(tracker.shouldReport('s\0a.ts', 'Read-only.')).toBe(true);
    });

    it('always reports a manual save and keeps it as the last reported failure', () => {
        const tracker = createSaveFailureTracker();
        tracker.shouldReport('s\0a.ts', 'Read-only.');
        expect(tracker.shouldReport('s\0a.ts', 'Read-only.', { force: true })).toBe(true);
        expect(tracker.shouldReport('s\0a.ts', 'Read-only.')).toBe(false);
    });
});
