import { describe, expect, it } from 'vitest';

import { summarizeProjectAccess } from '../mobile-access-summary';

describe('summarizeProjectAccess', () => {
    it('joins every resolved title when none are unavailable', () => {
        expect(summarizeProjectAccess(['Caxri', 'Website'])).toBe('Caxri, Website');
    });

    it('collapses repeated unresolved grants into one trailing count', () => {
        expect(summarizeProjectAccess(['Caxri', undefined, undefined])).toBe(
            'Caxri · +2 unavailable',
        );
    });

    it('reports only the count when every grant is unresolved', () => {
        expect(summarizeProjectAccess([undefined, undefined, undefined])).toBe('+3 unavailable');
    });

    it('reads as empty when the device has no grants at all', () => {
        expect(summarizeProjectAccess([])).toBe('');
    });
});
