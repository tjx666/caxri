import { describe, expect, it } from 'vitest';

import { appendClaudeTimelineRecord } from '../providers/claude/timeline';
import { appendCodexTimelineRecord } from '../providers/codex/timeline';
import { TimelineBuilder } from '../timeline-model';

/**
 * Sanitized native record shapes; see `timeline.test.ts` for their upstream references.
 */
describe('turn boundary outcome', () => {
    it('marks a completed Codex turn as completed', () => {
        const builder = new TimelineBuilder('fixture');
        appendCodexTimelineRecord(
            builder,
            { type: 'event_msg', payload: { type: 'task_complete' } },
            0,
        );
        expect(builder.entries[0]?.item).toMatchObject({
            type: 'turnBoundary',
            outcome: 'completed',
        });
    });

    it('marks an aborted Codex turn as interrupted', () => {
        const builder = new TimelineBuilder('fixture');
        appendCodexTimelineRecord(
            builder,
            { type: 'event_msg', payload: { type: 'turn_aborted', reason: 'interrupted' } },
            0,
        );
        expect(builder.entries[0]?.item).toMatchObject({
            type: 'turnBoundary',
            outcome: 'interrupted',
        });
    });

    it('leaves a Claude turn without a stated outcome', () => {
        const builder = new TimelineBuilder('fixture');
        appendClaudeTimelineRecord(
            builder,
            { type: 'system', subtype: 'turn_duration', durationMs: 900 },
            0,
        );
        expect(builder.entries[0]?.item).toMatchObject({ type: 'turnBoundary', durationMs: 900 });
        expect(builder.entries[0]?.item).not.toHaveProperty('outcome');
    });
});
