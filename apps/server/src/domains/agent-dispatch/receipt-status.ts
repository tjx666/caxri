import type { AgentDispatchFailure, AgentDispatchReceipt, ProcessState } from '@caxri/protocol';

import type { TerminalLifecycleCause } from '../terminal';

/**
 * Why a dispatch failed, as carried on the receipt's failure.
 */
export type DispatchReason = AgentDispatchFailure['reason'];

/**
 * The cause recorded with a dispatch status transition log: a Terminal lifecycle cause or a dispatch-owned step.
 */
export type TransitionReason =
    | TerminalLifecycleCause
    | 'created'
    | 'launchStarted'
    | 'launchReady'
    | 'launchFailed'
    | 'processFailed'
    | 'agentExit'
    | 'terminalSuspended'
    | 'userDetached'
    | 'processInterrupted';

/**
 * Whether a dispatch receipt reached a status no later Terminal state can change.
 */
export function isSettled(receipt: AgentDispatchReceipt): boolean {
    return ['stopped', 'interrupted', 'failed'].includes(receipt.status);
}

/**
 * The receipt status a dispatch takes when its Terminal reaches `state`; undefined leaves the receipt as it is.
 */
export function terminalStatePatch(
    state: ProcessState,
): { status: AgentDispatchReceipt['status']; failure?: AgentDispatchFailure } | undefined {
    switch (state) {
        case 'stopped':
            return { status: 'stopped' };
        /*
        `suspended` and `detached` both kill the launched process on purpose, and only a later wake or
        `session.resume` relaunches it, so a dispatch that was still running is interrupted rather than failed:
        the dispatcher must not wait for a receipt the Terminal can no longer deliver (#551).
        */
        case 'interrupted':
        case 'suspended':
        case 'detached':
            return { status: 'interrupted' };
        case 'dead':
        case 'failed':
            return { status: 'failed', failure: { code: 'UNAVAILABLE', reason: 'process_failed' } };
        default:
            return undefined;
    }
}
