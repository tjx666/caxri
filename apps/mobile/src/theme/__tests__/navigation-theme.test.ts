import { describe, expect, it } from 'vitest';

import { mobileNavigationColors } from '../navigation-theme';
import { mobileTheme } from '../tokens';

describe('mobileNavigationColors', () => {
    it('paints screens and the stack container with the app background', () => {
        expect(mobileNavigationColors(mobileTheme).background).toBe(mobileTheme.background);
    });
});
