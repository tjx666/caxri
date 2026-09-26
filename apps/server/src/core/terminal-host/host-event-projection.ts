import type { TerminalExecutionEvent, TerminalObserverEvent } from '../../domains/terminal';
import type { RemoteTerminalIdentity, TerminalHostEvent } from './execution-contract';

type LiveHostEvent = Exclude<TerminalHostEvent, { event: 'terminal.exit' }>;

/**
 * Projects generation-validated Host events without changing Desktop attachment ownership.
 */
export function projectLiveTerminalHostEvent(
    event: LiveHostEvent,
    identity: RemoteTerminalIdentity,
    attachmentId: string | undefined,
    emitExecution: (event: TerminalExecutionEvent) => void,
    emitObserver: (event: TerminalObserverEvent) => void,
): void {
    switch (event.event) {
        case 'terminal.output':
            // The requested Desktop view owns replay; old attachment bytes are already in its next snapshot.
            if (!attachmentId || event.identity.attachmentId !== attachmentId) return;
            emitExecution({
                type: 'output',
                terminalId: identity.record.id,
                data: event.data,
                ...(event.droppedBytes !== undefined && { droppedBytes: event.droppedBytes }),
            });
            return;
        case 'terminal.observer.output':
            emitObserver({
                type: 'output',
                terminalId: identity.record.id,
                generation: identity.generation,
                sequence: event.sequence,
                data: event.data,
            });
            return;
        case 'terminal.observer.gap':
            emitObserver({
                type: 'gap',
                terminalId: identity.record.id,
                generation: identity.generation,
                sequence: event.sequence,
                reason: event.reason,
            });
            return;
        case 'terminal.activity':
            emitExecution({
                type: 'activity',
                terminalId: identity.record.id,
                processId: event.processId,
            });
            return;
        case 'terminal.sizeOwnership':
            emitExecution({
                type: 'sizeOwnership',
                terminalId: identity.record.id,
                owner: event.owner,
                cols: event.cols,
                rows: event.rows,
            });
            return;
        case 'terminal.title':
            emitExecution({
                type: 'title',
                terminalId: identity.record.id,
                title: event.title,
            });
            return;
        case 'terminal.outputRecovery':
            emitExecution({
                type: 'outputRecovery',
                terminalId: identity.record.id,
                provider: event.provider,
                status: event.status,
            });
            return;
        case 'terminal.agent.started':
            if (identity.agent?.launchId !== event.launchId) return;
            identity.agent.processId = event.processId;
            emitExecution({
                type: 'agentStarted',
                terminalId: identity.record.id,
                launchId: event.launchId,
                processId: event.processId,
            });
            return;
        case 'terminal.agent.exit':
            if (identity.agent?.launchId !== event.launchId) return;
            delete identity.agent;
            emitExecution({
                type: 'agentExit',
                terminalId: identity.record.id,
                launchId: event.launchId,
                exitCode: event.exitCode,
                ...(event.signal !== undefined && { signal: event.signal }),
            });
    }
}
