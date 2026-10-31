import { describe, expect, it } from 'vitest';

import { isSessionPreviewObservable } from '../preview-availability';

const visible = {
    connectionScopeKey: 'scope',
    deviceRole: 'control' as const,
    isFocused: true,
    isForeground: true,
    route: 'direct' as const,
    status: 'connected',
};

describe('isSessionPreviewObservable', () => {
    it('asks for ports on a visible direct control connection', () => {
        expect(isSessionPreviewObservable(visible)).toBe(true);
    });

    it('never asks over the Relay, whose phone cannot reach the LAN preview proxy', () => {
        expect(isSessionPreviewObservable({ ...visible, route: 'relay' })).toBe(false);
    });

    it('never asks without a connection, for a reply device, or off screen', () => {
        expect(isSessionPreviewObservable({ ...visible, route: null })).toBe(false);
        expect(isSessionPreviewObservable({ ...visible, deviceRole: 'reply' })).toBe(false);
        expect(isSessionPreviewObservable({ ...visible, isFocused: false })).toBe(false);
    });
});
