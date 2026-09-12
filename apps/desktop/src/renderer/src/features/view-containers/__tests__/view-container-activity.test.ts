import { describe, expect, it } from 'vitest';

import { isViewContainerQueryEnabled } from '../view-container-activity';

describe('isViewContainerQueryEnabled', () => {
    it('pauses keep-alive reads while the container is hidden', () => {
        expect(isViewContainerQueryEnabled(false)).toBe(false);
        expect(isViewContainerQueryEnabled(false, true)).toBe(false);
    });

    it('keeps the extra Session or search gate when the container is visible', () => {
        expect(isViewContainerQueryEnabled(true)).toBe(true);
        expect(isViewContainerQueryEnabled(true, false)).toBe(false);
        expect(isViewContainerQueryEnabled(true, true)).toBe(true);
    });
});
