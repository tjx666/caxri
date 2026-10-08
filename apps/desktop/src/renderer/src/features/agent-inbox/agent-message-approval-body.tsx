import { Button } from '../../components/ui/button';

interface AgentMessageApprovalBodyProperties {
    /**
     * The complete text once the Server read settles; absent while it loads or after it failed.
     */
    body: string | undefined;
    /**
     * The truncated text the queue carried, shown only when an expired request can no longer be read in full.
     */
    preview: string;
    isExpired: boolean;
    failed: boolean;
    onRetry: () => void;
}

/**
 * The held peer message's text in its three states: loading, unreadable, and read. There is no empty state: the
 * protocol rejects an empty body (`agentMessageBodySchema`), so a blank panel here would always be a failed read
 * wearing the wrong clothes.
 */
export function AgentMessageApprovalBody({
    body,
    preview,
    isExpired,
    failed,
    onRetry,
}: AgentMessageApprovalBodyProperties) {
    return (
        <div className="min-h-24 rounded border border-border bg-background p-3 text-[11px] leading-5">
            {body !== undefined || isExpired ? (
                <pre
                    data-testid="agent-message-body"
                    className="m-0 max-h-48 overflow-auto font-mono break-words whitespace-pre-wrap text-foreground"
                >
                    {/* An expired request can no longer be read from the Server, so it keeps whatever was on screen,
                        down to the preview the list carried. */}
                    {body ?? preview}
                </pre>
            ) : failed ? (
                <div role="alert" data-testid="agent-message-body-error">
                    <p className="m-0 text-danger">The complete message could not be read.</p>
                    <p className="m-0 mt-1 text-muted">
                        Approve and Deny stay available without it; approving only delivers this
                        message and grants nothing. Retry loads the full text if you want to read it
                        first.
                    </p>
                    <Button variant="secondary" size="sm" className="mt-2" onClick={onRetry}>
                        Retry
                    </Button>
                </div>
            ) : (
                <p className="m-0 text-muted">Loading the complete message…</p>
            )}
        </div>
    );
}
