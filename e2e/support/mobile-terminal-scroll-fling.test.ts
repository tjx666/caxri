import { describe, expect, it } from 'vitest';

import { classifyFlingInjection, FLING_INJECTION_BUDGET_MS } from './mobile-terminal-scroll-fling';

describe('classifyFlingInjection', () => {
    it('accepts a gesture injected within the budget', () => {
        expect(classifyFlingInjection(350)).toBe('valid');
        expect(classifyFlingInjection(FLING_INJECTION_BUDGET_MS)).toBe('valid');
    });

    it('discards a gesture the loaded host injected late', () => {
        expect(classifyFlingInjection(FLING_INJECTION_BUDGET_MS + 1)).toBe('host-overloaded');
    });
});
