import { CaxriError } from '@caxri/protocol';
import type { FailureReason, LogWriteOptions } from '@caxri/system';

import type { RemoteTerminalIdentity, RemoteView } from './execution-contract';

/**
 * Puts the view the Renderer held before `view` back once the host rejected `view`. The output gate compares every host
 * frame against this map, so a rejected view left here mutes the frames the host keeps emitting under the attachment it
 * kept (#938). Skipped when an overlapping newer `attach` or a `detachView` already replaced the entry, since that call
 * owns it now.
 */
export function restoreRequestedView(
    views: Map<string, RemoteView>,
    terminalId: string,
    view: RemoteView,
    previous: RemoteView | undefined,
): void {
    if (views.get(terminalId) !== view) return;
    if (previous === undefined) views.delete(terminalId);
    else views.set(terminalId, previous);
}

/**
 * Puts the attachment Terminal Host still holds back on the identity after the host rejected `view`. The host keeps the
 * attachment it accepted last, so it goes on emitting under `published`; leaving the rejected id in place would let
 * input and the output gate name an attachment the host never confirmed and mute the Terminal until a later re-attach
 * happens to succeed (#910). Skipped when a newer re-attach or a detach already replaced this publication, since that
 * caller owns the field now. Returns whether the rollback applied.
 */
export function didRestorePublishedAttachment(
    identity: RemoteTerminalIdentity,
    view: RemoteView,
    published: string | undefined,
): boolean {
    if (identity.attachmentId !== view.attachmentId) return false;
    if (published === undefined) delete identity.attachmentId;
    else identity.attachmentId = published;
    return true;
}

/**
 * Closed reason for a rejected `terminal.attach`, so attach failures can be counted and filtered by cause instead of by
 * message text. The supervisor's own codes are the only ones a re-attach can fail with.
 */
function attachFailureReason(error: unknown): FailureReason {
    if (!(error instanceof CaxriError)) return 'unknown';
    switch (error.code) {
        case 'TIMEOUT':
            return 'timeout';
        case 'CAPACITY':
            return 'capacity';
        case 'UNAVAILABLE':
            return 'terminal-host-exited';
        case 'CANCELLED':
            return 'cancelled';
        case 'CONFLICT':
            return 'generation-superseded';
        default:
            return 'unknown';
    }
}

/**
 * Content-free record of one rejected re-attach: which Terminal, why the host refused, and whether Core could fall back
 * to the attachment the host kept. `hadAttachment` separates a failed first attach, which leaves nothing to forward
 * under, from a failed re-attach whose live output should keep flowing.
 */
export function attachFailureLog(
    identity: RemoteTerminalIdentity,
    published: string | undefined,
    error: unknown,
    isRolledBack: boolean,
): LogWriteOptions {
    const code = error instanceof CaxriError ? error.code : undefined;
    return {
        fields: {
            terminalId: identity.record.id,
            errorCode: code ?? 'UNKNOWN',
            errorType: error instanceof Error ? error.name : typeof error,
            rolledBack: isRolledBack,
            hadAttachment: published !== undefined,
        },
        failure: {
            ...(code && { code }),
            owner: 'terminal-host',
            phase: 'attach',
            reason: attachFailureReason(error),
            remediation: 'reconnect',
            retryable: true,
        },
    };
}
