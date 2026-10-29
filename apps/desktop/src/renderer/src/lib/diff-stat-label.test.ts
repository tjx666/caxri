import { describe, expect, it } from 'vitest';

import { translate } from '../i18n';
import { diffStatLabel } from './diff-stat-label';

describe('diffStatLabel', () => {
    it('keeps the exact counts in words', () => {
        expect(diffStatLabel({ additions: 1, deletions: 0 }, translate)).toBe(
            '1 line added, 0 removed',
        );
    });
});
