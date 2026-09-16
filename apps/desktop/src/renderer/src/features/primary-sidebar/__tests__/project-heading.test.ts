import { describe, expect, it } from 'vitest';

import { describeProjectSessionCount } from '../project-heading';

describe('describeProjectSessionCount', () => {
    it('names the count the heading renders as a bare digit', () => {
        expect(describeProjectSessionCount('caxri', 12)).toBe('caxri (12 Sessions)');
    });

    it('keeps the singular for one Session', () => {
        expect(describeProjectSessionCount('caxri', 1)).toBe('caxri (1 Session)');
    });

    it('still reports an empty Project, which is the case a collapsed heading cannot show', () => {
        expect(describeProjectSessionCount('caxri', 0)).toBe('caxri (0 Sessions)');
    });
});
