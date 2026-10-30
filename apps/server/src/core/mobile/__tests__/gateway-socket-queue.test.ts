import { describe, expect, it } from 'vitest';

import {
    MAXIMUM_QUEUED_MESSAGES,
    MOBILE_GATEWAY_MAX_WIRE_BYTES,
    MobileSocketQueueBudget,
} from '../gateway/socket-queue-budget';

describe('MobileSocketQueueBudget', () => {
    it('bounds queued message count and releases capacity exactly once', () => {
        const budget = new MobileSocketQueueBudget();
        const releases = Array.from({ length: MAXIMUM_QUEUED_MESSAGES }, () =>
            budget.tryAcquire(1),
        );

        expect(releases.every(Boolean)).toBe(true);
        expect(budget.tryAcquire(1)).toBeUndefined();

        releases[0]?.();
        releases[0]?.();
        expect(budget.tryAcquire(1)).toBeTypeOf('function');
    });

    it('bounds aggregate bytes independently of the WebSocket frame limit', () => {
        const budget = new MobileSocketQueueBudget();
        const releases = Array.from({ length: 4 }, () =>
            budget.tryAcquire(MOBILE_GATEWAY_MAX_WIRE_BYTES),
        );

        expect(releases.every(Boolean)).toBe(true);
        expect(budget.tryAcquire(1)).toBeUndefined();

        releases.at(-1)?.();
        expect(budget.tryAcquire(1)).toBeTypeOf('function');
    });
});
