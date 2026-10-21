import { describe, expect, it } from 'vitest';

import { sessionOpenPlace } from './open-sessions';

describe('sessionOpenPlace', () => {
    it('marks a Session in this strip as here once the strip is visible', () => {
        expect(sessionOpenPlace(['a', 'b'], [], 'a')).toBe('here');
    });

    it('withholds the here marker while the strip is hidden', () => {
        expect(sessionOpenPlace(['a'], [], 'a')).toBeUndefined();
        expect(sessionOpenPlace(undefined, undefined, 'a')).toBeUndefined();
    });

    it('marks a Session another window owns as elsewhere, even beside a hidden strip', () => {
        expect(sessionOpenPlace(['a', 'b'], ['x'], 'x')).toBe('elsewhere');
        expect(sessionOpenPlace(['a'], ['x'], 'x')).toBe('elsewhere');
    });

    it('leaves a Session in no strip unmarked', () => {
        expect(sessionOpenPlace(['a', 'b'], ['x'], 'c')).toBeUndefined();
    });
});
