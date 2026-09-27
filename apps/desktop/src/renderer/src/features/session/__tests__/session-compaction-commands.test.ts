import type { SessionCompactionOutcome, SessionCompactionResult } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import { describeSessionCompaction } from '../session-compaction-commands';

function resultOf(outcomes: SessionCompactionOutcome[], deferred = 0): SessionCompactionResult {
    return {
        items: outcomes.map((outcome, index) => ({ sessionId: `session-${index}`, outcome })),
        deferred,
    };
}

describe('describeSessionCompaction', () => {
    it('states only the headline when every Session was submitted', () => {
        expect(describeSessionCompaction(resultOf(['submitted', 'submitted']))).toBe(
            'Compaction requested for 2 Sessions.',
        );
    });

    it('keeps the headline singular for exactly one submitted Session', () => {
        expect(describeSessionCompaction(resultOf(['submitted']))).toBe(
            'Compaction requested for 1 Session.',
        );
    });

    it('states no Sessions were eligible when nothing was submitted', () => {
        expect(describeSessionCompaction(resultOf(['busy']))).toBe(
            'No Sessions were eligible for compaction. Skipped: 1 busy or compacting.',
        );
    });

    it('appends exactly one trailing clause with the skipped/unconfirmed breakdown', () => {
        const message = describeSessionCompaction(
            resultOf(['submitted', 'submitted', 'busy', 'failed', 'failed'], 3),
        );
        expect(message).toBe(
            'Compaction requested for 2 Sessions. Skipped: 1 busy or compacting; 2 delivery failed; 3 beyond the 200-Session batch limit.',
        );
        // A short headline plus one clause, never the old multi-sentence wall of text.
        expect(message.split('. ')).toHaveLength(2);
    });

    it('drops the deferred count when nothing was deferred', () => {
        expect(describeSessionCompaction(resultOf(['submitted', 'not_running']))).toBe(
            'Compaction requested for 1 Session. Skipped: 1 Agent stopped.',
        );
    });
});
