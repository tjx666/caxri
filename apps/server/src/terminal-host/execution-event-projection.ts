import type { TerminalSnapshot } from '@caxri/protocol';
import type { StructuredLogger } from '@caxri/system';
import { logEventCatalog } from '@caxri/system';

import type { TerminalExecutionEvent, TerminalExecutionExit } from './engine';
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

/**
 * Settles the managed-Agent cancel and the final snapshot capture of a naturally exited Terminal. Either may reject
 * (for example when the parser barrier fails); the caller must still release per-terminal state and send
 * `terminal.exit`, otherwise Core keeps showing an exited Terminal as live. A failure is logged with a closed phase and
 * the error class only (never Terminal content) and yields no snapshot.
 */
export async function settleTerminalExit(
    event: TerminalExecutionExit,
    agentLaunchId: string | undefined,
    host: {
        agentLauncher?: { cancel(terminalId: string, launchId: string): Promise<unknown> };
        logger: StructuredLogger;
    },
): Promise<TerminalSnapshot | undefined> {
    const logFailure = (step: 'cancel' | 'capture', error: unknown): void =>
        host.logger.write('warn', logEventCatalog.terminalHost.error, {
            fields: {
                phase: 'exit-finalize',
                step,
                terminalId: event.record.id,
                errorType: error instanceof Error ? error.name : typeof error,
            },
        });
    // Settled separately so a rejected cancel neither drops the snapshot nor leaves the capture rejection unhandled.
    try {
        if (agentLaunchId) await host.agentLauncher?.cancel(event.record.id, agentLaunchId);
    } catch (error) {
        logFailure('cancel', error);
    }
    try {
        return await event.capture;
    } catch (error) {
        logFailure('capture', error);
        return undefined;
    }
}
