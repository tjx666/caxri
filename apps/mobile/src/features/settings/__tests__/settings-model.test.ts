import { describe, expect, it } from 'vitest';

import { connectionStatusLabel, deviceRoleDetails } from '../settings-model';

describe('settings model', () => {
    it('names every role with the capability it adds', () => {
        expect(deviceRoleDetails('view').label).toBe('View');
        expect(deviceRoleDetails('reply').label).toBe('Reply');
        expect(deviceRoleDetails('control').description).toContain('rename, and archive Sessions');
    });

    it('labels connection states for people, not for the state machine', () => {
        expect(connectionStatusLabel('storage-error')).toBe('Saved pairing unavailable');
        expect(connectionStatusLabel('connected')).toBe('Connected');
        expect(connectionStatusLabel('stale')).toBe('Reconnecting…');
        expect(connectionStatusLabel('version-mismatch')).toBe('Update required');
    });
});
