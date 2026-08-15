import type { AgentHeldMessage, AgentHeldMessageDetail } from '@shared/ipc';
import { useEffect, useMemo, useState } from 'react';

import { Button } from '../../components/ui/button';
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
} from '../../components/ui/dialog';
import { caxri } from '../../lib/caxri';
import { describeFailure, pushToast } from '../../stores/toasts';
import {
    heldMessageActionResultForError,
    updateHeldMessagesAfterAction,
} from './agent-message-approval-state';

function upsert(messages: AgentHeldMessage[], incoming: AgentHeldMessage): AgentHeldMessage[] {
    const next = messages.filter((message) => message.messageId !== incoming.messageId);
    next.push(incoming);
    return next.sort((left, right) => left.createdAt - right.createdAt);
}

/**
 * Presents Host-held peer text as inert plain text. Approve moves only this message into the
 * receiver Inbox; neither action grants authority, writes terminal input, or changes policy.
 */
export function AgentMessageApprovalDialog() {
    const [messages, setMessages] = useState<AgentHeldMessage[]>([]);
    const [detail, setDetail] = useState<AgentHeldMessageDetail>();
    const [detailFailed, setDetailFailed] = useState(false);
    const [pending, setPending] = useState(false);
    const current = messages[0];
    const currentMessageId = current?.messageId;

    useEffect(() => {
        let active = true;
        void caxri
            .request('agent.message.held')
            .then(({ messages: initial }) => active && setMessages(initial))
            .catch((error: unknown) =>
                pushToast('error', describeFailure(error, 'Unable to load held peer messages')),
            );
        const unsubscribe = caxri.onEvent((event) => {
            if (event.event === 'agent.message.held')
                setMessages((existing) => upsert(existing, event.payload));
            if (event.event === 'agent.message.receipt' && event.payload.status !== 'held')
                setMessages((existing) =>
                    existing.filter(({ messageId }) => messageId !== event.payload.messageId),
                );
        });
        const expiryTimer = window.setInterval(
            () =>
                setMessages((existing) =>
                    existing.filter(({ expiresAt }) => expiresAt > Date.now()),
                ),
            1_000,
        );
        return () => {
            active = false;
            unsubscribe();
            window.clearInterval(expiryTimer);
        };
    }, []);

    useEffect(() => {
        let active = true;
        setDetail(undefined);
        setDetailFailed(false);
        if (!currentMessageId) return () => undefined;
        void caxri
            .request('agent.message.held.get', { messageId: currentMessageId })
            .then((value) => active && setDetail(value))
            .catch((error: unknown) => {
                if (!active) return;
                setDetailFailed(true);
                pushToast(
                    'error',
                    describeFailure(error, 'Unable to load the complete peer message'),
                );
            });
        return () => {
            active = false;
        };
    }, [currentMessageId]);

    const endpointRef = useMemo(() => {
        if (!current) return '';
        const { hostId, endpointId, generation } = current.from.ref;
        return `${hostId}:${endpointId}:${generation}`;
    }, [current]);

    async function settle(action: 'approve' | 'deny'): Promise<void> {
        if (!current || pending) return;
        if (action === 'approve' && detail?.messageId !== current.messageId) return;
        setPending(true);
        try {
            await caxri.request(`agent.message.${action}`, { messageId: current.messageId });
            setMessages((existing) =>
                updateHeldMessagesAfterAction(existing, current.messageId, 'confirmed'),
            );
        } catch (error) {
            pushToast('error', describeFailure(error, `Unable to ${action} peer message`));
            setMessages((existing) =>
                updateHeldMessagesAfterAction(
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
        <Dialog open={Boolean(current)}>
            <DialogContent showCloseButton={false} data-testid="agent-message-approval-dialog">
                <DialogHeader>
                    <DialogTitle>Peer message approval</DialogTitle>
                    <DialogDescription>
                        This is inert Agent-to-Agent text. Approving delivers only this message and
                        does not grant permissions, change settings, or execute a command.
                    </DialogDescription>
                </DialogHeader>
                {current && (
                    <div className="space-y-3 p-4">
                        <dl className="grid grid-cols-[88px_minmax(0,1fr)] gap-x-3 gap-y-1 text-[11px]">
                            <dt className="text-muted">Sender</dt>
                            <dd className="m-0 truncate">{current.from.name}</dd>
                            <dt className="text-muted">Project</dt>
                            <dd className="m-0 truncate">{current.from.projectId}</dd>
                            <dt className="text-muted">Provider</dt>
                            <dd className="m-0">{current.from.provider}</dd>
                            <dt className="text-muted">Permission</dt>
                            <dd className="m-0">{current.from.permissionClass}</dd>
                            <dt className="text-muted">Endpoint</dt>
                            <dd className="m-0 truncate font-mono" title={endpointRef}>
                                {endpointRef}
                            </dd>
                        </dl>
                        <pre
                            data-testid="agent-message-body"
                            className="m-0 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded border border-border bg-background p-3 font-mono text-[11px] leading-5 text-foreground"
                        >
                            {detail?.body ??
                                (detailFailed
                                    ? 'Unable to load the complete message.'
                                    : 'Loading complete message…')}
                        </pre>
                        <div className="flex justify-end gap-2">
                            <Button
                                variant="secondary"
                                disabled={pending}
                                onClick={() => void settle('deny')}
                            >
                                Deny
                            </Button>
                            <Button
                                disabled={pending || detail?.messageId !== current.messageId}
                                onClick={() => void settle('approve')}
                            >
                                Approve message
                            </Button>
                        </div>
                    </div>
                )}
            </DialogContent>
        </Dialog>
    );
}
