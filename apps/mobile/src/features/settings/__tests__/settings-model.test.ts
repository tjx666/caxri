import { describe, expect, it } from 'vitest';

import { connectionStatusLabel, DEVICE_ROLE_DETAILS } from '../settings-model';

describe('settings model', () => {
    it('names every role with the capability it adds', () => {
        expect(Object.keys(DEVICE_ROLE_DETAILS)).toEqual(['view', 'reply', 'control']);
        expect(DEVICE_ROLE_DETAILS.control.description).toContain('rename, and archive Sessions');
    });

    it('labels connection states for people, not for the state machine', () => {
        expect(connectionStatusLabel('connected')).toBe('Connected');
        expect(connectionStatusLabel('stale')).toBe('Reconnecting…');
        expect(connectionStatusLabel('version-mismatch')).toBe('Update required');
    });
});
