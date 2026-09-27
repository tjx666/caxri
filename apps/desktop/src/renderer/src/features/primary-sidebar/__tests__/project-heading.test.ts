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

describe('describeProjectSessionCount with an Agent summary', () => {
    it('names running and unread Sessions a collapsed heading only draws', () => {
        expect(describeProjectSessionCount('caxri', 4, { attention: 1, running: 2 })).toBe(
            'caxri (4 Sessions), 2 running, 1 needs attention',
        );
        expect(describeProjectSessionCount('caxri', 3, { attention: 3, running: 0 })).toBe(
            'caxri (3 Sessions), 3 need attention',
        );
    });

    it('adds nothing when no Agent is running or unread', () => {
        expect(describeProjectSessionCount('caxri', 2, { attention: 0, running: 0 })).toBe(
            'caxri (2 Sessions)',
        );
    });
});
