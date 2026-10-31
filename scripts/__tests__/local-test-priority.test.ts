import { describe, expect, it, vi } from 'vitest';

import { LOCAL_TEST_NICENESS, lowerLocalTestPriority } from '../local-test-priority';

describe('local test priority', () => {
    it('lowers the runner priority on a developer machine', () => {
        const lower = vi.fn();
        lowerLocalTestPriority({}, lower);
        expect(lower).toHaveBeenCalledExactlyOnceWith(LOCAL_TEST_NICENESS);
    });

    it('keeps the default priority on CI', () => {
        const lower = vi.fn();
        lowerLocalTestPriority({ CI: 'true' }, lower);
        expect(lower).not.toHaveBeenCalled();
    });

    it('still runs tests when the system refuses the priority change', () => {
        expect(() =>
            lowerLocalTestPriority({}, () => {
                throw new Error('EACCES');
            }),
        ).not.toThrow();
    });
});
