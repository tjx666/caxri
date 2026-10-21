import { describe, expect, it } from 'vitest';

import { isSessionOpenElsewhere } from './open-sessions';

describe('isSessionOpenElsewhere', () => {
    it('marks a Session another window has open', () => {
        expect(isSessionOpenElsewhere(['x', 'y'], 'x')).toBe(true);
    });

    it('leaves every other Session unmarked, including before the first bootstrap', () => {
        expect(isSessionOpenElsewhere(['x'], 'a')).toBe(false);
        expect(isSessionOpenElsewhere(undefined, 'a')).toBe(false);
    });
});
