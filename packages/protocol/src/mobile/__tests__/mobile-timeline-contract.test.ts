import { describe, expect, it } from 'vitest';

import { agentTimelineItemSchema } from '../mobile-timeline-contract.js';

describe('agentTimelineItemSchema turnBoundary', () => {
    it.each(['completed', 'interrupted', 'failed'] as const)('accepts a %s outcome', (outcome) => {
        expect(agentTimelineItemSchema.parse({ id: 'b1', type: 'turnBoundary', outcome })).toEqual({
            id: 'b1',
            type: 'turnBoundary',
            outcome,
        });
    });

    it('keeps the outcome optional for a record that only marks the end', () => {
        expect(
            agentTimelineItemSchema.parse({ id: 'b1', type: 'turnBoundary', durationMs: 4_000 }),
        ).toEqual({ id: 'b1', type: 'turnBoundary', durationMs: 4_000 });
    });

    it('rejects an outcome outside the closed set', () => {
        expect(
            agentTimelineItemSchema.safeParse({
                id: 'b1',
                type: 'turnBoundary',
                outcome: 'running',
            }).success,
        ).toBe(false);
    });
});
