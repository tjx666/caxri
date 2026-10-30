import { MOBILE_GATEWAY_MAX_WIRE_BYTES } from '@caxri/mobile-transport';
import { describe, expect, it } from 'vitest';

import { MobileSocketReaderBudget } from '../socket-reader-budget';

describe('MobileSocketReaderBudget', () => {
    it('bounds both one message and the queued message count', () => {
        const budget = new MobileSocketReaderBudget();
        expect(budget.tryAcquire(MOBILE_GATEWAY_MAX_WIRE_BYTES + 1)).toBeUndefined();
        const releases = Array.from({ length: 256 }, () => budget.tryAcquire(1));
        expect(releases.every(Boolean)).toBe(true);
        expect(budget.tryAcquire(1)).toBeUndefined();
        releases[0]?.();
        expect(budget.tryAcquire(1)).toBeTypeOf('function');
    });
});
