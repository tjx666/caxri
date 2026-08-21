import { describe, expect, it } from 'vitest';

import type { HostConnectionState } from '../host-connection-state';
import { initialHostConnectionState, transitionHostConnection } from '../host-connection-state';

function transition(
    state: HostConnectionState,
    event: Parameters<typeof transitionHostConnection>[1],
): HostConnectionState {
    return transitionHostConnection(state, event);
}

describe('Desktop Host connection state machine', () => {
    it('moves initial attachment through attached readiness', () => {
        const attaching = transition(initialHostConnectionState, { type: 'start' });
        const attached = transition(attaching, {
            type: 'attachment-succeeded',
            hostContinuity: 'same',
        });

        expect(attaching).toEqual({ status: 'attaching', mode: 'initial' });
        expect(attached).toEqual({ status: 'attached' });
        expect(transition(attached, { type: 'desktop-ready' })).toEqual({ status: 'ready' });
    });

    it('retains outage timing and readiness across failed reconnect attempts', () => {
        const lost = transition(
            { status: 'ready' },
            {
                type: 'connection-lost',
                atMs: 1_000,
                reason: 'transport',
            },
        );
        const retrying = transition(lost, { type: 'backoff-elapsed' });
        const backoff = transition(retrying, { type: 'attachment-failed' });

        expect(lost).toEqual({
            status: 'backoff',
            attempt: 1,
            outageStartedAtMs: 1_000,
            readiness: 'announced',
        });
        expect(retrying).toEqual({
            status: 'attaching',
            mode: 'reconnect',
            attempt: 1,
            outageStartedAtMs: 1_000,
            readiness: 'announced',
        });
        expect(backoff).toEqual({
            status: 'backoff',
            attempt: 2,
            outageStartedAtMs: 1_000,
            readiness: 'announced',
        });
    });

    it('keeps retrying when a recovered attachment is lost during readiness restoration', () => {
        const recovering: HostConnectionState = {
            status: 'recovering',
            attempt: 1,
            hostContinuity: 'same',
            outageStartedAtMs: 1_000,
            readiness: 'announced',
        };

        expect(
            transition(recovering, {
                type: 'connection-lost',
                atMs: 2_000,
                reason: 'transport',
            }),
        ).toEqual({
            status: 'backoff',
            attempt: 2,
            outageStartedAtMs: 1_000,
            readiness: 'announced',
        });
    });

    it('completes recovery in the readiness state held before the outage', () => {
        const recovering = (readiness: 'announced' | 'pending'): HostConnectionState => ({
            status: 'recovering',
            attempt: 1,
            hostContinuity: 'replaced',
            outageStartedAtMs: 1_000,
            readiness,
        });

        expect(transition(recovering('announced'), { type: 'recovery-completed' })).toEqual({
            status: 'ready',
        });
        expect(transition(recovering('pending'), { type: 'recovery-completed' })).toEqual({
            status: 'attached',
        });
    });

    it.each(['replaced', 'disposed'] as const)('keeps %s as a terminal state', (status) => {
        const terminal: HostConnectionState = { status };

        expect(transition(terminal, { type: 'start' })).toBe(terminal);
        expect(
            transition(terminal, {
                type: 'connection-lost',
                atMs: 1_000,
                reason: 'transport',
            }),
        ).toBe(terminal);
    });

    it('separates lease replacement from recoverable transport loss', () => {
        expect(
            transition(
                { status: 'ready' },
                {
                    type: 'connection-lost',
                    atMs: 1_000,
                    reason: 'replaced',
                },
            ),
        ).toEqual({ status: 'replaced' });
        expect(transition({ status: 'ready' }, { type: 'dispose' })).toEqual({
            status: 'disposed',
        });
    });
});
