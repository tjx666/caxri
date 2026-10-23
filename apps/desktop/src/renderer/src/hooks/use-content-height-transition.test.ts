import { describe, expect, it } from 'vitest';

import { contentHeightTransitionToken } from './use-content-height-transition';

describe('contentHeightTransitionToken', () => {
    it('expands when the content grows and collapses when it shrinks', () => {
        expect(contentHeightTransitionToken(0, 124)).toBe('--motion-expand');
        expect(contentHeightTransitionToken(124, 0)).toBe('--motion-collapse');
    });
});
