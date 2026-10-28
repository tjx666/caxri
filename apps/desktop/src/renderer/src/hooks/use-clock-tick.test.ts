import { describe, expect, it } from 'vitest';

import { clockTickSnapshot } from './use-clock-tick';

describe('clockTickSnapshot', () => {
    it('holds one value for every read inside a tick and moves at the boundary', () => {
        expect(clockTickSnapshot(60_000, 120_000)).toBe(120_000);
        expect(clockTickSnapshot(60_000, 179_999)).toBe(120_000);
        expect(clockTickSnapshot(60_000, 180_000)).toBe(180_000);
    });
});
