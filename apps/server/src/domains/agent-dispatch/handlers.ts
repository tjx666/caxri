import { Buffer } from 'node:buffer';

import type { ServerEvent } from '@caxri/protocol';
import { CaxriError } from '@caxri/protocol';

import type { AgentEndpointLifecycle } from '../agent-endpoints';
import type { AgentCoordinator } from '../agents';
import type { CaxriDatabase } from '../db';
import type { DomainHandlers } from '../domain-services';
import { assertPtyTerminal } from '../pty-guard';
import type { TerminalManager } from '../terminal';
import type { AgentDispatchService } from './service';

type AgentCommandMethod =
    | 'agent.dispatch.start'
    | 'agent.dispatch.resume'
    | 'agent.dispatch.status'
    | 'agent.dispatch.wait'
    | 'agent.control.interrupt'
    | 'agent.control.stop'
    | 'terminal.send'
    | 'agent.dispatch.startInternal'
    | 'agent.dispatch.resumeInternal'
    | 'agent.dispatch.wakeInternal'
    | 'agent.dispatch.statusInternal'
    | 'agent.dispatch.waitInternal'
    | 'agent.dispatch.cancelWaitInternal'
    | 'agent.control.interruptInternal'
    | 'agent.control.stopInternal'
    | 'terminal.sendInternal';

export interface AgentCommandHandlerOptions {
    coordinator: AgentCoordinator;
    database: CaxriDatabase;
    dispatch: AgentDispatchService;
    endpoints?: AgentEndpointLifecycle;
    mainOwned(method: AgentCommandMethod): never;
    emit(event: ServerEvent): void;
    terminals: TerminalManager;
}

/**
 * Keeps public Server ownership and private Server PTY ownership visibly separated.
 */
export function createAgentCommandHandlers(
    options: AgentCommandHandlerOptions,
): Pick<DomainHandlers, AgentCommandMethod> {
    const recordUserSubmission = (terminalId: string): void => {
        const terminal = options.database.getTerminal(terminalId);
        if (!terminal) return;
        if (!options.database.touchSessionActivity(terminal.sessionId, 'user_submission')) return;
        options.emit({
            event: 'state.changed',
            payload: { kind: 'records', sessionIds: [terminal.sessionId], terminalIds: [] },
        });
    };
    const signalAgent = (
        endpoint: Parameters<DomainHandlers['agent.control.interruptInternal']>[0]['endpoint'],
        signal: 'SIGINT' | 'SIGHUP',
    ) => {
        if (!options.endpoints)
            throw new CaxriError('UNAVAILABLE', 'Agent Endpoint control is unavailable');
        const target = options.endpoints.controlTarget(endpoint);
        if (
            !options.endpoints.isCurrent(target) ||
            !options.terminals.signalAgentExact(target.terminalId, target.launchId, signal)
        )
            throw new CaxriError('UNAVAILABLE', 'Agent Endpoint generation is unavailable');
        if (signal === 'SIGINT')
            options.coordinator.observeInterrupt(target.terminalId, target.launchId);
        return { endpoint, terminalId: target.terminalId, outcome: 'signaled' as const };
    };

    return {
        'agent.dispatch.start': () => options.mainOwned('agent.dispatch.start'),
        'agent.dispatch.resume': () => options.mainOwned('agent.dispatch.resume'),
        'agent.dispatch.status': () => options.mainOwned('agent.dispatch.status'),
        'agent.dispatch.wait': () => options.mainOwned('agent.dispatch.wait'),
        'agent.control.interrupt': () => options.mainOwned('agent.control.interrupt'),
        'agent.control.stop': () => options.mainOwned('agent.control.stop'),
        'terminal.send': () => options.mainOwned('terminal.send'),
        'agent.dispatch.startInternal': ({ dispatchId, input, principal }) =>
            options.dispatch.start(dispatchId, principal, input),
        'agent.dispatch.resumeInternal': ({ dispatchId, input, principal }) =>
            options.dispatch.resume(dispatchId, principal, input),
        'agent.dispatch.wakeInternal': ({ dispatchId, principal, target }) =>
            options.dispatch.wake(dispatchId, principal, target),
        'agent.dispatch.statusInternal': ({ dispatchId, projectScope }) =>
            options.dispatch.status(dispatchId, projectScope),
        'agent.dispatch.waitInternal': ({
            afterRevision,
            dispatchId,
            projectScope,
            timeoutMs,
            waitId,
        }) => options.dispatch.wait(dispatchId, projectScope, afterRevision, timeoutMs, waitId),
        'agent.dispatch.cancelWaitInternal': ({ waitId }) => ({
            canceled: options.dispatch.cancelWait(waitId),
        }),
        'agent.control.interruptInternal': ({ endpoint }) => signalAgent(endpoint, 'SIGINT'),
        'agent.control.stopInternal': ({ endpoint }) => signalAgent(endpoint, 'SIGHUP'),
        'terminal.sendInternal': async ({ attentionEpoch, enter, terminalId, text }, signal) => {
            if (signal?.aborted) throw new CaxriError('CANCELLED', 'Terminal input was canceled');
            // Reject before an attention reply is consumed: a Chat answers through `agentChat.respond`.
            assertPtyTerminal(options.database.getTerminal(terminalId));
            let claimedSessionId: string | undefined;
            let claimedActivityAt: number | undefined;
            if (attentionEpoch !== undefined) {
                const terminal = options.database.getTerminal(terminalId);
                const session = terminal
                    ? options.database.getSession(terminal.sessionId)
                    : undefined;
                if (
                    !session ||
                    !terminal ||
                    terminal.kind === 'shell' ||
                    session.primaryAgentTerminalId !== terminalId ||
                    session.lastActivityState !== 'waiting' ||
                    session.attentionEpoch !== attentionEpoch
                )
                    throw new CaxriError(
                        'CONFLICT',
                        'Agent attention changed before the reply was accepted',
                    );
                if (
                    !options.database.consumeSessionAttentionReply(
                        session.id,
                        terminalId,
                        attentionEpoch,
                    )
                )
                    throw new CaxriError(
                        'CONFLICT',
                        'Agent attention changed before the reply was accepted',
                    );
                claimedSessionId = session.id;
                claimedActivityAt = session.lastSessionActivityAt;
            }
            const data = `${text}${enter ? '\r' : ''}`;
            const isRunning = options.terminals.processId(terminalId) !== undefined;
            let didWrite: boolean;
            try {
                if (signal?.aborted)
                    throw new CaxriError('CANCELLED', 'Terminal input was canceled');
                didWrite =
                    attentionEpoch === undefined
                        ? options.terminals.write(terminalId, data)
                        : await options.terminals.writeAgent(terminalId, data, signal);
            } catch (error) {
                if (claimedSessionId && attentionEpoch !== undefined)
                    options.database.releaseSessionAttentionReply(
                        claimedSessionId,
                        terminalId,
                        attentionEpoch,
                        claimedActivityAt!,
                    );
                throw error;
            }
            if (!didWrite) {
                if (claimedSessionId && attentionEpoch !== undefined)
                    options.database.releaseSessionAttentionReply(
                        claimedSessionId,
                        terminalId,
                        attentionEpoch,
                        claimedActivityAt!,
                    );
                throw new CaxriError('UNAVAILABLE', 'Terminal is no longer running');
            }
            const observed = isRunning && options.coordinator.observeInput(terminalId, data);
            if (claimedSessionId) {
                options.database.touchSessionActivity(claimedSessionId, 'user_submission');
                options.emit({
                    event: 'state.changed',
                    payload: {
                        kind: 'records',
                        sessionIds: [claimedSessionId],
                        terminalIds: [],
                    },
                });
            } else if (observed) recordUserSubmission(terminalId);
            return {
                terminalId,
                accepted: true,
                byteLength: Buffer.byteLength(text, 'utf8'),
                enter,
            };
        },
    };
}
