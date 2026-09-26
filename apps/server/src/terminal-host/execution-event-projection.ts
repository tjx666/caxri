import type { TerminalExecutionEvent } from './engine';
import type { TerminalHostMessage } from './protocol';

type TerminalEventIdentity = Extract<
    TerminalHostMessage,
    { type: 'event'; event: 'terminal.activity' }
>['identity'];

/**
 * Projects live PTY events through the Host's generation-bound wire identity.
 */
export function projectTerminalExecutionEvent(
    event: TerminalExecutionEvent,
    identity: TerminalEventIdentity,
    send: (message: TerminalHostMessage) => void,
): void {
    switch (event.type) {
        case 'output':
            if (!identity.attachmentId) return;
            send({
                type: 'event',
                event: 'terminal.output',
                identity: { ...identity, attachmentId: identity.attachmentId },
                data: event.data,
                ...(event.droppedBytes !== undefined && { droppedBytes: event.droppedBytes }),
            });
            return;
        case 'observerOutput':
            send({
                type: 'event',
                event: 'terminal.observer.output',
                identity,
                sequence: event.sequence,
                data: event.data,
            });
            return;
        case 'observerGap':
            send({
                type: 'event',
                event: 'terminal.observer.gap',
                identity,
                sequence: event.sequence,
                reason: event.reason,
            });
            return;
        case 'activity':
            send({
                type: 'event',
                event: 'terminal.activity',
                identity,
                processId: event.processId,
            });
            return;
        case 'sizeOwnership':
            send({
                type: 'event',
                event: 'terminal.sizeOwnership',
                identity,
                owner: event.owner,
                cols: event.cols,
                rows: event.rows,
            });
            return;
        case 'title':
            send({
                type: 'event',
                event: 'terminal.title',
                identity,
                title: event.title,
            });
            return;
        case 'outputRecovery':
            send({
                type: 'event',
                event: 'terminal.outputRecovery',
                identity,
                provider: event.provider,
                status: event.status,
            });
    }
}
