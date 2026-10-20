import type { SshEnvironmentState } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import {
    canCancelConnection,
    canReconnect,
    canRetryNow,
    connectionFailureCopy,
    connectionFailureDetail,
    connectionFailureTone,
    connectionPhaseLabel,
    hostKeyResetCommand,
    installProgressPercent,
    isConnectionBusy,
    isConnectionOverlayVisible,
    isRetryAttemptRunning,
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
        expect(isConnectionBusy('stopped')).toBe(true);
    });

    it('offers Retry Now only while reconnecting, disabled during an attempt', () => {
        const waiting = state({
            phase: 'reconnecting',
            failure: { reason: 'unreachable', message: '' },
        });
        expect(canRetryNow(waiting)).toBe(true);
        expect(isRetryAttemptRunning(waiting)).toBe(false);
        expect(isRetryAttemptRunning(state({ phase: 'reconnecting', attempt: 2 }))).toBe(true);
        expect(canRetryNow(state({ phase: 'failed' }))).toBe(false);
        expect(canRetryNow(state({ phase: 'connecting' }))).toBe(false);
    });

    it('offers only Close Window when the SSH Host does not meet the Server requirements', () => {
        for (const reason of ['unsupportedPlatform', 'unsupportedGlibc', 'missingTool'] as const) {
            expect(canReconnect(state({ phase: 'failed', failure: { reason, message: '' } }))).toBe(
                false,
            );
        }
        expect(
            canReconnect(
                state({ phase: 'failed', failure: { reason: 'unreachable', message: '' } }),
            ),
        ).toBe(true);
    });

    it('offers Cancel only while an attempt runs', () => {
        expect(canCancelConnection(state({ phase: 'connecting' }))).toBe(true);
        expect(canCancelConnection(state({ phase: 'reconnecting' }))).toBe(true);
        expect(canCancelConnection(state({ phase: 'failed' }))).toBe(false);
        expect(canCancelConnection(state({ phase: 'stopped' }))).toBe(false);
    });

    it('labels a cancelled attempt and numbers automatic reconnects', () => {
        expect(
            connectionPhaseLabel(
                state({ phase: 'failed', failure: { reason: 'cancelled', message: 'x' } }),
            ),
        ).toEqual({ key: 'sshHost.phase.cancelled' });
        expect(connectionPhaseLabel(state({ phase: 'reconnecting', attempt: 3 }))).toEqual({
            key: 'sshHost.phase.reconnectingAttempt',
            values: { attempt: 3 },
        });
        expect(connectionPhaseLabel(state({ phase: 'reconnecting' }))).toEqual({
            key: 'sshHost.phase.reconnecting',
        });
    });

    it('names the machine holding a profile and hides the detail of a cancel', () => {
        expect(
            connectionFailureCopy({ reason: 'profileInUse', message: '', holder: 'laptop' }),
        ).toEqual({ key: 'sshHost.failure.profileInUseHost', values: { hostname: 'laptop' } });
        expect(connectionFailureCopy({ reason: 'profileInUse', message: '' })).toEqual({
            key: 'sshHost.failure.profileInUse',
        });
        expect(
            connectionFailureDetail({ reason: 'cancelled', message: 'Connection cancelled' }),
        ).toBe(undefined);
        expect(connectionFailureDetail({ reason: 'unreachable', message: 'timed out' })).toBe(
            'timed out',
        );
        expect(connectionFailureDetail({ reason: 'unreachable', message: '' })).toBeUndefined();
    });

    it('tones a cancel as muted, a takeover or retry as a warning, and the rest as danger', () => {
        const tone = (
            phase: SshEnvironmentState['phase'],
            reason: 'cancelled' | 'takenOver' | 'unreachable',
        ) => connectionFailureTone(state({ phase, failure: { reason, message: '' } }));
        expect(tone('failed', 'cancelled')).toBe('muted');
        expect(tone('disconnected', 'takenOver')).toBe('warning');
        expect(tone('reconnecting', 'unreachable')).toBe('warning');
        expect(tone('failed', 'unreachable')).toBe('danger');
    });

    it('builds a quoted known_hosts reset command only for host-key failures', () => {
        expect(
            hostKeyResetCommand({
                reason: 'hostKey',
                message: '',
                knownHostsName: '[devbox]:2222',
            }),
        ).toBe("ssh-keygen -R '[devbox]:2222'");
        expect(hostKeyResetCommand({ reason: 'hostKey', message: '' })).toBeUndefined();
        expect(
            hostKeyResetCommand({ reason: 'unreachable', message: '', knownHostsName: 'devbox' }),
        ).toBeUndefined();
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
