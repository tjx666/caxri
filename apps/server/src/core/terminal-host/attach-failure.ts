import { CaxriError } from '@caxri/protocol';
import type { FailureReason, LogWriteOptions } from '@caxri/system';

import type { RemoteTerminalIdentity, RemoteView } from './execution-contract';

/**
 * Puts the view Terminal Host still holds back once the host rejected `view` without ever taking it (see
 * `shouldRollBackAttachment`). The output gate compares every host frame against this map, so a rejected view left here
 * mutes the frames the host keeps emitting under the attachment it kept (#938). Restores `previous` only when the host
 * confirmed it; an earlier overlapping attach may have left a never-accepted view there, in which case a fresh entry
 * naming the held attachment replaces it. Skipped when an overlapping newer `attach` or a `detachView` already replaced
 * the entry, since that call owns it now.
 */
export function restoreRequestedView(
    views: Map<string, RemoteView>,
    terminalId: string,
    view: RemoteView,
    previous: RemoteView | undefined,
    identity: RemoteTerminalIdentity,
    error: unknown,
): void {
    if (!shouldRollBackAttachment(error) || views.get(terminalId) !== view) return;
    const held = identity.heldAttachmentId;
    if (held === undefined) views.delete(terminalId);
    else if (previous?.attachmentId === held) views.set(terminalId, previous);
    else
        views.set(terminalId, {
            attachmentId: held,
            ...(previous?.size && { size: previous.size }),
        });
}

/**
 * Puts the attachment Terminal Host still holds back on the identity after the host rejected `view` without ever taking
 * it (see `shouldRollBackAttachment`). The host then goes on emitting under `heldAttachmentId`; leaving the rejected id
 * in place would let input and the output gate name an attachment the host never confirmed and mute the Terminal until
 * a later re-attach happens to succeed (#910). Skipped when a newer re-attach or a detach already replaced this
 * publication, since that caller owns the field now. Returns whether the rollback applied.
 */
export function didRestorePublishedAttachment(
    identity: RemoteTerminalIdentity,
    view: RemoteView,
    error: unknown,
): boolean {
    if (!shouldRollBackAttachment(error) || identity.attachmentId !== view.attachmentId)
        return false;
    if (identity.heldAttachmentId === undefined) delete identity.attachmentId;
    else identity.attachmentId = identity.heldAttachmentId;
    return true;
}

/**
 * Drops both the published and the host-confirmed attachment once the Renderer detaches its view.
 */
export function forgetAttachment(identity: RemoteTerminalIdentity): void {
    delete identity.attachmentId;
    delete identity.heldAttachmentId;
}

/**
 * Error code of a rejected `terminal.attach`. Supervisor-raised failures are `CaxriError`s, but the host's own
 * pre-dispatch refusal travels as a plain `Error` carrying `code: 'CAPABILITY_DENIED'` because that code is not part of
 * the protocol's `errorCodes` (see `replyError` in `supervisor.ts`), so the enum below reads `code` off either shape.
 */
function attachErrorCode(error: unknown): string | undefined {
    if (error instanceof CaxriError) return error.code;
    if (error instanceof Error && 'code' in error && typeof error.code === 'string')
        return error.code;
    return undefined;
}

/**
 * Whether Core may put the previous attachment back after `terminal.attach` failed with `error`. Terminal Host adopts
 * the requested attachment the moment its handler runs (`runtime.ts`, `terminal.attach`), before any attach work that
 * could still fail, so a rollback is only correct when the handler provably never ran:
 *
 * - `CAPACITY` and `UNAVAILABLE` are raised by the supervisor before or while sending, so the host never saw the frame;
 * - `CAPABILITY_DENIED` is the host's authorization refusal, which runs before dispatch touches the attachment.
 *
 * Every other outcome leaves the requested attachment in place. A `TIMEOUT` or `CANCELLED` frame is still in the
 * channel and the host adopts the requested id once it gets to it (the late reply is simply dropped), and an error
 * thrown inside the handler happens after adoption. Rolling those back would make Core name an attachment the host no
 * longer holds, muting the Terminal in the opposite direction.
 */
function shouldRollBackAttachment(error: unknown): boolean {
    switch (attachErrorCode(error)) {
        case 'CAPACITY':
        case 'UNAVAILABLE':
        case 'CAPABILITY_DENIED':
            return true;
        default:
            return false;
    }
}

/**
 * Closed reason for a rejected `terminal.attach`, so attach failures can be counted and filtered by cause instead of by
 * message text. `CAPABILITY_DENIED` is the host refusing a stale scope (unknown Terminal, Session mismatch, or an older
 * PTY generation), which is the same "superseded" cause the enum already names.
 */
function attachFailureReason(error: unknown): FailureReason {
    switch (attachErrorCode(error)) {
        case 'TIMEOUT':
            return 'timeout';
        case 'CAPACITY':
            return 'capacity';
        case 'UNAVAILABLE':
            return 'terminal-host-exited';
        case 'CANCELLED':
            return 'cancelled';
        case 'CONFLICT':
        case 'CAPABILITY_DENIED':
            return 'generation-superseded';
        default:
            return 'unknown';
    }
}

/**
 * Content-free record of one rejected re-attach: which Terminal, why the host refused, and whether Core fell back to
 * the attachment the host kept (`rolledBack: false` means the requested attachment stays published because the host
 * adopted, or will adopt, it; see `shouldRollBackAttachment`). `hadAttachment` separates a failed first attach, which
 * leaves nothing to forward under, from a failed re-attach whose live output should keep flowing.
 */
export function attachFailureLog(
    identity: RemoteTerminalIdentity,
    error: unknown,
    isRolledBack: boolean,
): LogWriteOptions {
    const code = attachErrorCode(error);
    return {
        fields: {
            terminalId: identity.record.id,
            errorCode: code ?? 'UNKNOWN',
            errorType: error instanceof Error ? error.name : typeof error,
            rolledBack: isRolledBack,
            hadAttachment: identity.heldAttachmentId !== undefined,
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
