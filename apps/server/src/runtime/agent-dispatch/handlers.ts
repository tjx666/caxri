import { Buffer } from 'node:buffer';

import { CaxriError } from '@caxri/protocol';

import type { RuntimeAgentEndpointLifecycle } from '../agent-endpoints';
import type { AgentCoordinator } from '../agents';
import type { RuntimeHandlers } from '../dispatch';
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
    dispatch: AgentDispatchService;
    endpoints?: RuntimeAgentEndpointLifecycle;
    mainOwned(method: AgentCommandMethod): never;
    terminals: TerminalManager;
}

/**
 * Keeps public Host ownership and private Runtime PTY ownership visibly separated.
 */
export function createAgentCommandHandlers(
    options: AgentCommandHandlerOptions,
): Pick<RuntimeHandlers, AgentCommandMethod> {
    const signalAgent = (
        endpoint: Parameters<RuntimeHandlers['agent.control.interruptInternal']>[0]['endpoint'],
        signal: 'SIGINT' | 'SIGHUP',
    ) => {
        if (!options.endpoints)
            throw new CaxriError('UNAVAILABLE', 'Agent Endpoint control is unavailable');
        const target = options.endpoints.controlTarget(endpoint);
        const processId = options.terminals.processId(target.terminalId);
        if (
            processId === undefined ||
            !options.endpoints.isCurrent(target) ||
            !options.terminals.signalExact(target.terminalId, processId, signal)
        )
            throw new CaxriError('UNAVAILABLE', 'Agent Endpoint generation is unavailable');
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
        'terminal.sendInternal': ({ enter, terminalId, text }) => {
            const data = `${text}${enter ? '\r' : ''}`;
            if (options.terminals.processId(terminalId) !== undefined)
                options.coordinator.observeInput(terminalId, data);
            if (!options.terminals.write(terminalId, data))
                throw new CaxriError('UNAVAILABLE', 'Terminal is no longer running');
            return {
                terminalId,
                accepted: true,
                byteLength: Buffer.byteLength(text, 'utf8'),
                enter,
            };
        },
    };
}
