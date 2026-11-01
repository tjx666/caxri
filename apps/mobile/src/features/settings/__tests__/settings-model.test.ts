import { describe, expect, it } from 'vitest';

import { connectionStatusLabel, connectionStatusView, deviceRoleDetails } from '../settings-model';

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

    it('names the route of a live connection', () => {
        expect(connectionStatusView('connected', 'relay', null)).toEqual({
            detail: undefined,
            value: 'Connected · via Relay',
        });
        expect(connectionStatusView('connected', 'direct', null).value).toBe('Connected · Direct');
        expect(connectionStatusView('connected', null, null).value).toBe('Connected');
    });

    it('explains a Relay refusal while the connection is down', () => {
        const view = connectionStatusView('stale', null, 'host-offline');
        expect(view.value).toBe('Reconnecting…');
        expect(view.detail).toContain('offline');
        expect(connectionStatusView('stale', null, null).detail).toBeUndefined();
    });
});
