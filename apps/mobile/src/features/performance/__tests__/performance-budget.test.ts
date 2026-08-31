import { describe, expect, it } from 'vitest';

import { performanceBudgetFailures } from '../performance-budget';

describe('performanceBudgetFailures', () => {
    it('returns only metrics above their fixed budget', () => {
        expect(
            performanceBudgetFailures({
                coldStartMs: 2_501,
                droppedFrameRatio: 0.01,
                firstInteractiveMs: 1_500,
                hotStartMs: 901,
            }),
        ).toEqual(['coldStartMs', 'hotStartMs']);
    });
});
