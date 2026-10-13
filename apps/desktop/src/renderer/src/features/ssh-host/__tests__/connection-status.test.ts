import type { SshEnvironmentState } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import {
    canReconnect,
    installProgressPercent,
    isConnectionBusy,
    isConnectionOverlayVisible,
    reconnectLabelKey,
} from '../connection-status';

function state(overrides: Partial<SshEnvironmentState> = {}): SshEnvironmentState {
    return {
        kind: 'ssh',
        destination: 'devbox',
        hostIdentity: 'devbox',
        phase: 'connecting',
        needsUserAction: false,
        ...overrides,
    };
}

describe('connection status', () => {
    it('covers the window whenever the SSH Host is not connected', () => {
        expect(isConnectionOverlayVisible(undefined)).toBe(false);
        expect(isConnectionOverlayVisible(state({ phase: 'connected' }))).toBe(false);
        expect(isConnectionOverlayVisible(state({ phase: 'reconnecting' }))).toBe(true);
        expect(isConnectionOverlayVisible(state({ phase: 'failed' }))).toBe(true);
    });

    it('offers Reconnect only once Main stopped trying', () => {
        expect(canReconnect(state({ phase: 'failed' }))).toBe(true);
        expect(canReconnect(state({ phase: 'disconnected' }))).toBe(true);
        expect(canReconnect(state({ phase: 'reconnecting' }))).toBe(false);
        expect(isConnectionBusy('reconnecting')).toBe(true);
        expect(isConnectionBusy('failed')).toBe(false);
    });

    it('offers to take the Server back after another Desktop took it over', () => {
        const takenOver = state({
            phase: 'disconnected',
            needsUserAction: false,
            failure: { reason: 'takenOver', message: '' },
        });
        expect(canReconnect(takenOver)).toBe(true);
        expect(reconnectLabelKey(takenOver)).toBe('sshHost.useHere');
        expect(reconnectLabelKey(state({ phase: 'failed' }))).toBe('sshHost.reconnect');
    });

    it('reports clamped whole-percent progress only while installing', () => {
        expect(
            installProgressPercent(
                state({ phase: 'installing', progress: { completedBytes: 1, totalBytes: 3 } }),
            ),
        ).toBe(33);
        expect(
            installProgressPercent(
                state({ phase: 'installing', progress: { completedBytes: 9, totalBytes: 3 } }),
            ),
        ).toBe(100);
        expect(
            installProgressPercent(
                state({ phase: 'installing', progress: { completedBytes: 0, totalBytes: 0 } }),
            ),
        ).toBeUndefined();
        expect(
            installProgressPercent(
                state({ phase: 'starting', progress: { completedBytes: 1, totalBytes: 2 } }),
            ),
        ).toBeUndefined();
    });
});
