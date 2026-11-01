import { describe, expect, it } from 'vitest';

import {
    androidSerialLockWaitMs,
    withAndroidSerialLockWaitHint,
} from '../mobile-android-serial-lock';

const busy = new Error('Timed out waiting for switch-worktree operation PID 4242');

describe('androidSerialLockWaitMs', () => {
    it('keeps the repository lock default when unset', () => {
        expect(androidSerialLockWaitMs(undefined)).toBe(10_000);
    });

    it('accepts whole seconds from 1 to 1800', () => {
        expect(androidSerialLockWaitMs('1')).toBe(1000);
        expect(androidSerialLockWaitMs('1800')).toBe(1_800_000);
    });

    it.each(['', '0', '1801', '1.5', '-5', '30s'])('rejects %j before any build', (raw) => {
        expect(() => androidSerialLockWaitMs(raw)).toThrow(
            'CAXRI_MOBILE_ACCEPTANCE_SERIAL_LOCK_WAIT requires an integer from 1 to 1800 seconds',
        );
    });
});

describe('withAndroidSerialLockWaitHint', () => {
    it('names the wait variable when a busy serial was not waited for', () => {
        const hinted = withAndroidSerialLockWaitHint(busy, undefined);
        expect(hinted).toBeInstanceOf(Error);
        expect((hinted as Error).message).toContain(
            'rerun with CAXRI_MOBILE_ACCEPTANCE_SERIAL_LOCK_WAIT=<seconds> (1-1800)',
        );
        expect((hinted as Error).cause).toBe(busy);
    });

    it('leaves the error alone once the caller already waited', () => {
        expect(withAndroidSerialLockWaitHint(busy, '600')).toBe(busy);
    });

    it('leaves case failures alone', () => {
        const failure = new Error('Android Acceptance case failed');
        expect(withAndroidSerialLockWaitHint(failure, undefined)).toBe(failure);
    });
});
