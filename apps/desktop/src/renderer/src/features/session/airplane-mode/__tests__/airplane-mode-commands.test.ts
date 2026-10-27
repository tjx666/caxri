import { describe, expect, it } from 'vitest';

import { pickedAirplaneModeSessions } from '../airplane-mode-commands';

describe('pickedAirplaneModeSessions', () => {
    it('resumes every parked Session the user did not untick, in parked order', () => {
        expect(pickedAirplaneModeSessions(['s1', 's2', 's3'], new Set(['s2']))).toEqual([
            's1',
            's3',
        ]);
        expect(pickedAirplaneModeSessions(['s1'], new Set(['s1']))).toEqual([]);
    });
});
