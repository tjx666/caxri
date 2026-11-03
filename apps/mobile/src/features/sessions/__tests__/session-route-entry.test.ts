import { describe, expect, it } from 'vitest';

import { sessionScreenAnimation } from '../session-route-entry';

describe('sessionScreenAnimation', () => {
    it('fades a Session in when it replaces the New Session sheet on a phone', () => {
        expect(sessionScreenAnimation({ entry: 'new' }, 'ios_from_right')).toBe('fade');
    });

    it('keeps the sideways push for a Session opened from the list', () => {
        expect(sessionScreenAnimation({ 'session-id': 's1' }, 'ios_from_right')).toBe(
            'ios_from_right',
        );
        expect(sessionScreenAnimation(undefined, 'ios_from_right')).toBe('ios_from_right');
    });

    it('keeps the split view static on a tablet', () => {
        expect(sessionScreenAnimation({ entry: 'new' }, 'none')).toBe('none');
    });
});
