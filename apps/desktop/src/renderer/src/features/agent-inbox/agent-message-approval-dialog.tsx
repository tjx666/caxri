import { useEffect, useRef, useState } from 'react';

import type { AgentHeldMessageDetail } from '@caxri/protocol';

import { Alert } from '../../components/ui/alert';
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
} from '../../components/ui/dialog';
import { describeFailure, pushToast } from '../../stores/toasts';
import { AgentMessageApprovalActions } from './agent-message-approval-actions';
import { AgentMessageApprovalBody } from './agent-message-approval-body';
import { getHeldAgentMessage, settleHeldAgentMessage } from './agent-message-approval-client';
import {
    acknowledgeExpiredHeldMessage,
    deferHeldMessage,
    deferredHeldMessages,
    heldMessageActionResultForError,
    loadHeldMessageDetail,
    presentedHeldMessage,
    removeHeldMessage,
    reviewHeldMessage,
    settleHeldMessage,
} from './agent-message-approval-state';
import { updateHeldMessageQueue, useHeldMessageQueueStore } from './agent-message-approval-store';
import { AgentMessageApprovalSummary } from './agent-message-approval-summary';
import { AgentMessageApprovalWaitingList } from './agent-message-approval-waiting-list';

/**
 * The confirming button is found by attribute rather than by ref because `Button` renders a plain `<button>` without
 * forwarding one, which is the same lookup `ConfirmationDialog` uses.
 */
function approvalConfirmButton(popup: HTMLElement | null): HTMLButtonElement | null {
    return popup?.querySelector<HTMLButtonElement>('[data-approval-confirm]') ?? null;
}

/**
 * Presents Server-held peer text as inert plain text. Approve moves only this message into the receiver Inbox; neither
 * action grants authority, writes terminal input, or changes policy.
 *
 * Escape, the close button, and an outside click set the request aside instead of answering it: the text is inert, so a
 * reflex keystroke must not manufacture a final rejection the sender can read. That only holds because the deferred
 * request stops being modal and keeps standing in `AgentMessageApprovalWaitingList` and the status bar's count; an
 * Escape that silently left the request unanswered with nowhere to answer it would be worse than the trap it replaced.
 *
 * The queue itself lives in `useHeldMessageQueueStore`, fed by `subscribeHeldMessageQueue` from the App, so the status
 * bar reads the same requests this dialog and its waiting list do.
 *
 * A request that expires while it is on screen, its approval window closed, or the Server voided it because the
 * receiving Agent restarted, stays on screen, marked expired, with Dismiss as its only action (see
 * `HeldMessageQueue.expired`): the reader learns that what they were reading is void instead of watching it vanish, or
 * be replaced by the next request mid-decision.
 */
export function AgentMessageApprovalDialog() {
    const queue = useHeldMessageQueueStore((state) => state.queue);
    const [detail, setDetail] = useState<AgentHeldMessageDetail>();
    const [detailFailed, setDetailFailed] = useState(false);
    const [detailAttempt, setDetailAttempt] = useState(0);
    const [pending, setPending] = useState(false);
    const contentReference = useRef<HTMLDivElement>(null);
    const presented = presentedHeldMessage(queue);
    const current = presented?.message;
    const isExpired = presented?.isExpired === true;
    const waiting = deferredHeldMessages(queue);
    const currentMessageId = current?.messageId;
    const readyDetail =
        currentMessageId !== undefined && detail?.messageId === currentMessageId
            ? detail
            : undefined;
    const isBodyReady = readyDetail !== undefined;
    /**
     * Only an unsettled read holds Approve: a failed read is a display problem, and approving grants nothing.
     */
    const isBodyLoading = !isBodyReady && !detailFailed;

    useEffect(() => {
        setDetail(undefined);
        setDetailFailed(false);
        const messageId = currentMessageId;
        if (!messageId) return () => {};
        let isActive = true;
        // eslint-disable-next-line no-void -- the loader owns error handling and the effect cleanup only flips isActive
        void loadHeldMessageDetail({
            isActive: () => isActive,
            onDetail: setDetail,
            onFailure: (error) => {
                setDetailFailed(true);
                pushToast(
                    'error',
                    describeFailure(error, 'Unable to load the complete peer message'),
                );
            },
            onStale: () =>
                updateHeldMessageQueue((existing) => removeHeldMessage(existing, messageId)),
            request: () => getHeldAgentMessage(messageId),
        });
        return () => {
            isActive = false;
        };
    }, [currentMessageId, detailAttempt]);

    /**
     * Base UI resolves `initialFocus` while the body is still loading, when `Approve message` is disabled and cannot
     * accept focus, so it resolves to the popup itself. Hand the confirming button its focus once the read settles, and
     * only from that parked state, so a user who already moved to another action keeps where they are.
     *
     * Why a listener and not a single attempt: Base UI resolves `initialFocus` in a microtask and only calls `.focus()`
     * a frame later (`FloatingFocusManager` through `enqueueFocus`). A body that lands between those two points finds
     * focus still outside the dialog, on the Agent's Terminal, so the effect declines to move it, and the queued focus
     * then parks on the popup with nobody left to hand it over. That is how this dialog ended up focusing its own
     * container in roughly every other run. Listening for the popup's own `focus` closes that window.
     *
     * Why it hands over exactly once: the popup carries `tabIndex={-1}`, so clicking any non-interactive part of the
     * dialog (the title, the sender table, the message body) focuses it. Re-running the hand-over there would yank
     * focus mid-drag and wipe the text selection, and the body is the one thing a reviewer needs to be able to read and
     * copy before deciding. `focus` does not bubble, so this never fires while the user is on a real control.
     *
     * Why `document.body` counts as parked: from the second message onward it is the only state this ever sees.
     * Approving disables the button while the request is in flight, which drops focus to the body, and Base UI does not
     * restore it: its restore path requires the old element to be hidden, and a disabled button is still visible. Its
     * own initial-focus effect does not re-run either, since nothing it depends on changed. Delete that half and every
     * message after the first one opens with no focused control.
     */
    useEffect(() => {
        if (isBodyLoading) return;
        const popup = contentReference.current;
        if (!popup) return;
        let isHandedOver = false;
        const handOverFocus = (): void => {
            if (isHandedOver) return;
            if (document.activeElement !== popup && document.activeElement !== document.body) {
                // The user is already on a real control in this dialog, so the hand-over is moot. Spend it anyway:
                // left armed, it would fire on their next click in the body and take the selection with it.
                if (popup.contains(document.activeElement)) isHandedOver = true;
                return;
            }
            const confirm = approvalConfirmButton(popup);
            // An in-flight request disables the button, and focusing a disabled element is a no-op; retry on the next
            // focus rather than spending the hand-over on nothing.
            if (!confirm || confirm.disabled) return;
            isHandedOver = true;
            confirm.focus();
        };
        handOverFocus();
        popup.addEventListener('focus', handOverFocus);
        return () => popup.removeEventListener('focus', handOverFocus);
    }, [isBodyLoading]);

    /**
     * Expiry removes Approve and Deny from under the reader, and a removed button drops focus to the document body,
     * outside the dialog's focus trap. Dismiss takes the confirming slot, so hand focus to it unless the user is
     * already on another control in the dialog.
     */
    useEffect(() => {
        if (!isExpired) return;
        const popup = contentReference.current;
        if (!popup) return;
        const focused = document.activeElement;
        if (focused !== popup && popup.contains(focused)) return;
        approvalConfirmButton(popup)?.focus();
    }, [isExpired]);

    /**
     * Retires the presentation without answering: the message stays held, the sender stays pending, and the request
     * moves to the waiting list. Never reached by Approve or Deny, which answer through {@link settle}.
     */
    function deferCurrent(): void {
        if (!currentMessageId) return;
        updateHeldMessageQueue((existing) => deferHeldMessage(existing, currentMessageId));
    }

    /**
     * An expired request has nothing left to set aside, so every way out of its notice just acknowledges it.
     */
    function dismissExpired(): void {
        updateHeldMessageQueue(acknowledgeExpiredHeldMessage);
    }

    async function settle(action: 'approve' | 'deny'): Promise<void> {
        if (!current || pending) return;
        if (action === 'approve' && isBodyLoading) return;
        setPending(true);
        try {
            await settleHeldAgentMessage(action, current.messageId);
            updateHeldMessageQueue((existing) =>
                settleHeldMessage(existing, current.messageId, 'confirmed'),
            );
        } catch (error) {
            pushToast('error', describeFailure(error, `Unable to ${action} peer message`));
            updateHeldMessageQueue((existing) =>
                settleHeldMessage(
                    existing,
                    current.messageId,
                    heldMessageActionResultForError(error),
                ),
            );
        } finally {
            setPending(false);
        }
    }

    return (
        <>
            <Dialog
                open={Boolean(current)}
                onOpenChange={(nextOpen) => {
                    if (nextOpen) return;
                    if (isExpired) dismissExpired();
                    // Escape, the close button, and an outside click all mean "not now", never "no".
                    else deferCurrent();
                }}
            >
                {current && (
                    <DialogContent
                        ref={contentReference}
                        // Closing this dialog sets the request aside; it does not refuse it. The X's glyph cannot carry
                        // that distinction, so its accessible name has to.
                        closeLabel={isExpired ? 'Dismiss' : 'Decide later'}
                        data-testid="agent-message-approval-dialog"
                        initialFocus={() => {
                            const confirm = approvalConfirmButton(contentReference.current);
                            // Base UI focuses exactly what this resolver names and never falls back when it names an
                            // element (`FloatingFocusManager`: `elToFocus || getDefaultFocusElement()`). Naming the
                            // confirming button while the body still loads makes it `disabled`, `.focus()` a no-op, and
                            // focus stay outside the dialog entirely: keystrokes would reach the Agent behind it. The
                            // popup itself always accepts focus, and the effect above hands it over once the read settles.
                            return confirm?.disabled === false ? confirm : contentReference.current;
                        }}
                    >
                        <DialogHeader>
                            <DialogTitle>
                                {isExpired ? 'Peer message expired' : 'Peer message approval'}
                            </DialogTitle>
                            {/* Expired, there is no approving left to explain; the notice below says what happened instead. */}
                            {!isExpired && (
                                <DialogDescription>
                                    This is inert Agent-to-Agent text. Approving delivers only this
                                    message and does not grant permissions, change settings, or
                                    execute a command.
                                </DialogDescription>
                            )}
                        </DialogHeader>
                        <div className="space-y-3 p-4">
                            {isExpired && (
                                <Alert variant="warning" data-testid="agent-message-expired">
                                    This request expired before it was answered. It can no longer be
                                    approved or denied, and the message was not delivered.
                                </Alert>
                            )}
                            <AgentMessageApprovalSummary message={current} isExpired={isExpired} />
                            <AgentMessageApprovalBody
                                body={readyDetail?.body}
                                failed={detailFailed}
                                isExpired={isExpired}
                                preview={current.preview}
                                onRetry={() => {
                                    setDetailFailed(false);
                                    setDetailAttempt((attempt) => attempt + 1);
                                }}
                            />
                            <AgentMessageApprovalActions
                                isBodyLoading={isBodyLoading}
                                isExpired={isExpired}
                                pending={pending}
                                onDefer={deferCurrent}
                                onDismiss={dismissExpired}
                                onSettle={(action) => {
                                    // eslint-disable-next-line no-void -- intentional floating-promise discard, settle() reports its own errors via toast
                                    void settle(action);
                                }}
                            />
                        </div>
                    </DialogContent>
                )}
            </Dialog>
            {/*
             * Hidden while a message is presented: the list sits under the dialog's backdrop, so a `Review` click
             * there lands on the backdrop, reads as an outside press, and defers the message on screen rather than
             * opening the one that was clicked. One decision is asked at a time, and the list returns the moment the
             * dialog is answered or set aside.
             */}
            {!current && (
                <AgentMessageApprovalWaitingList
                    approvals={waiting}
                    onReview={(messageId) =>
                        updateHeldMessageQueue((existing) => reviewHeldMessage(existing, messageId))
                    }
                />
            )}
        </>
    );
}
