import { describe, expect, it } from 'vitest';

import {
    AGENT_ACTIVITY_FINISHED_RETENTION_MS,
    isWithinFinishedRetention,
} from '../agent-activity-retention';

const NOW = 1_000_000_000;

describe('isWithinFinishedRetention', () => {
    it('keeps a Session that finished just now', () => {
        expect(isWithinFinishedRetention({ lastSessionActivityAt: NOW }, NOW)).toBe(true);
    });

    it('keeps a Session one millisecond before the window closes', () => {
        const at = NOW - AGENT_ACTIVITY_FINISHED_RETENTION_MS + 1;
        expect(isWithinFinishedRetention({ lastSessionActivityAt: at }, NOW)).toBe(true);
    });

    it('drops a Session exactly at the window boundary', () => {
        const at = NOW - AGENT_ACTIVITY_FINISHED_RETENTION_MS;
        expect(isWithinFinishedRetention({ lastSessionActivityAt: at }, NOW)).toBe(false);
    });

    it('keeps a Session whose activity clock is somehow ahead of the reader', () => {
        expect(isWithinFinishedRetention({ lastSessionActivityAt: NOW + 5_000 }, NOW)).toBe(true);
    });
});
