import { Button } from '../../components/ui/button';

interface AgentMessageApprovalActionsProperties {
    isExpired: boolean;
    /**
     * An answer is in flight, so no second answer or deferral may start.
     */
    pending: boolean;
    /**
     * The body is still loading, which holds Approve only: a reader should not approve text they have not seen.
     */
    isBodyLoading: boolean;
    onDefer: () => void;
    onDismiss: () => void;
    onSettle: (action: 'approve' | 'deny') => void;
}

/**
 * The approval dialog's footer. The confirming button carries `data-approval-confirm`, which is how the dialog finds it
 * to hand focus over; an expired request's Dismiss takes that slot, because Approve and Deny no longer exist.
 */
export function AgentMessageApprovalActions({
    isExpired,
    pending,
    isBodyLoading,
    onDefer,
    onDismiss,
    onSettle,
}: AgentMessageApprovalActionsProperties) {
    if (isExpired)
        return (
            <div className="flex justify-end gap-2">
                <Button data-approval-confirm onClick={onDismiss}>
                    Dismiss
                </Button>
            </div>
        );
    return (
        <>
            <p className="m-0 text-[11px] text-muted">
                Decide later, Escape, and closing this dialog all leave the request waiting. None of
                them answers the sender.
            </p>
            <div className="flex justify-end gap-2">
                <Button variant="ghost" disabled={pending} onClick={onDefer}>
                    Decide later
                </Button>
                <Button variant="secondary" disabled={pending} onClick={() => onSettle('deny')}>
                    Deny
                </Button>
                <Button
                    data-approval-confirm
                    disabled={pending || isBodyLoading}
                    onClick={() => onSettle('approve')}
                >
                    Approve message
                </Button>
            </div>
        </>
    );
}
