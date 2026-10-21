import { describe, expect, it } from 'vitest';

import { grokRewindPoint } from '../rewind/grok-rewind';

const listed = {
    rewind_points: [
        { prompt_index: 2, prompt_preview: 'third prompt' },
        { prompt_index: 0, prompt_preview: 'first prompt' },
        { prompt_index: 1, prompt_preview: 'a much longer second prompt that Grok …' },
    ],
};

describe('Grok rewind point', () => {
    it('counts back from the newest prompt', () => {
        expect(grokRewindPoint(listed, { removedTurns: 1, text: 'third prompt' })).toBe(2);
        expect(
            grokRewindPoint(listed, {
                removedTurns: 2,
                text: 'a much  longer second prompt that Grok truncated',
            }),
        ).toBe(1);
    });

    it('refuses when the preview names another message or the list is too short', () => {
        expect(
            grokRewindPoint(listed, { removedTurns: 1, text: 'something else' }),
        ).toBeUndefined();
        expect(grokRewindPoint(listed, { removedTurns: 4, text: 'first prompt' })).toBeUndefined();
        expect(grokRewindPoint({}, { removedTurns: 1, text: 'x' })).toBeUndefined();
        const unnamed = {
            rewind_points: [{ prompt_index: 0 }, { prompt_index: 1, prompt_preview: '' }],
        };
        expect(grokRewindPoint(unnamed, { removedTurns: 1, text: 'x' })).toBeUndefined();
        expect(grokRewindPoint(unnamed, { removedTurns: 2, text: 'x' })).toBeUndefined();
    });
});
