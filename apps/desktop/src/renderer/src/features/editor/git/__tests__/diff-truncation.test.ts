import { describe, expect, it } from 'vitest';

import { translate } from '../../../../i18n';
import { describeTruncatedGitChanges, shouldShowGitTruncationBanner } from '../diff-truncation';

describe('shouldShowGitTruncationBanner', () => {
    it('shows the banner only for a truncated working-tree change set', () => {
        expect(shouldShowGitTruncationBanner('working', true)).toBe(true);
    });

    it('never shows the banner for an untruncated change set', () => {
        expect(shouldShowGitTruncationBanner('working', false)).toBe(false);
    });

    it('never shows the banner for a pull request diff, which is never truncated the same way', () => {
        expect(shouldShowGitTruncationBanner('pull-request', true)).toBe(false);
    });
});

describe('describeTruncatedGitChanges', () => {
    it('names the visible count against the true total', () => {
        expect(describeTruncatedGitChanges(2_000, 5_312, translate)).toBe(
            'Showing the first 2,000 of 5,312 changes',
        );
    });
});
