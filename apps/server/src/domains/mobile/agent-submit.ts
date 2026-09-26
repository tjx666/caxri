import { createHash } from 'node:crypto';

import type { ServerOperationParameters } from '@caxri/protocol';
import { CaxriError } from '@caxri/protocol';

import type { AgentEndpointLifecycle } from '../agent-endpoints';
import type { CaxriDatabase } from '../db';
import type { MobileTerminalMutationQueue } from '../mobile-terminal-mutation-queue';
import type { TerminalManager } from '../terminal';
import type { MobileImageStore } from './image-store';

type Parameters = ServerOperationParameters<'mobile.agent.submitInternal'>;

export function createMobileAgentSubmitHandler(options: {
    database: CaxriDatabase;
    endpoints?: AgentEndpointLifecycle;
    images?: Pick<MobileImageStore, 'paths'>;
    queue: Pick<MobileTerminalMutationQueue, 'runProjectSessionTerminal'>;
    terminals: Pick<TerminalManager, 'submitAgentExact'>;
}) {
    const submit = async (parameters: Parameters, signal?: AbortSignal) => {
        const { principal, sessionId, terminalId, endpoint, clientMutationId, text } = parameters;
        if (principal.kind !== 'paired-device' || principal.role === 'view')
            throw new CaxriError('FORBIDDEN', 'Device cannot submit Agent input');
        const attachmentIds = parameters.attachmentIds ?? [];
        const session = options.database.getSession(sessionId);
        if (
            !session ||
            !principal.projectIds.includes(session.projectId) ||
            options.database
                .listVisibleProjects()
                .every((project) => project.id !== session.projectId)
        )
            throw new CaxriError('NOT_FOUND', 'Session not found');
        const identity = {
            deviceId: principal.deviceId,
            deviceGeneration: principal.generation,
            clientMutationId,
            requestFingerprint: createHash('sha256')
                .update(JSON.stringify([sessionId, terminalId, endpoint, text, attachmentIds]))
                .digest('hex'),
        };
        const previous = options.database.mobileAgentSubmitReceipts.find(identity);
        if (previous) return { terminalId, outcome: previous } as const;
        if (attachmentIds.length > 0 && !options.images)
            throw new CaxriError('UNAVAILABLE', 'Image attachments are unavailable');
        const attachmentPaths =
            attachmentIds.length > 0
                ? options.images!.paths(
                      `${principal.deviceId}:${principal.generation}`,
                      sessionId,
                      attachmentIds,
                  )
                : [];
        const submission =
            attachmentPaths.length > 0
                ? `${text}\n\nAttached image paths:\n${attachmentPaths.join('\n')}`
                : text;
        const terminal = options.database.getTerminal(terminalId);
        if (!terminal || terminal.sessionId !== sessionId)
            throw new CaxriError('NOT_FOUND', 'Terminal not found');
        if (
            terminal.kind === 'shell' ||
            session.primaryAgentTerminalId !== terminalId ||
            terminal.lastProcessState !== 'running'
        )
            throw new CaxriError('CONFLICT', 'Primary Agent Terminal changed');
        const target = options.endpoints?.controlTarget(endpoint);
        if (!target || target.terminalId !== terminalId)
            throw new CaxriError('CONFLICT', 'Agent Endpoint changed');
        if (signal?.aborted) throw new CaxriError('CANCELLED', 'Mobile submission was canceled');
        const state = options.database.mobileAgentSubmitReceipts.reserve(identity);
        if (state !== 'reserved')
            return { terminalId, outcome: state === 'accepted' ? 'accepted' : 'unknown' } as const;
        if (signal?.aborted || !options.endpoints?.isCurrent(target)) {
            options.database.mobileAgentSubmitReceipts.removeRejected(identity);
            throw new CaxriError('CONFLICT', 'Agent Endpoint changed before submission');
        }
        /**
         * An uncertain Host result leaves a durable reservation so no write can be retried.
         */
        let isRejected = false;
        try {
            const result = await options.terminals.submitAgentExact(
                terminalId,
                sessionId,
                target.launchId,
                submission,
                signal,
            );
            if (result === 'rejected') {
                options.database.mobileAgentSubmitReceipts.removeRejected(identity);
                isRejected = true;
                throw new CaxriError('CONFLICT', 'Agent Terminal changed before submission');
            }
            if (result !== 'accepted') return { terminalId, outcome: 'unknown' } as const;
            options.database.mobileAgentSubmitReceipts.markAccepted(identity);
            return { terminalId, outcome: 'accepted' } as const;
        } catch (error) {
            if (isRejected) throw error;
            return { terminalId, outcome: 'unknown' } as const;
        }
    };
    return (parameters: Parameters, signal?: AbortSignal) => {
        const projectId = options.database.getSession(parameters.sessionId)?.projectId;
        return options.queue.runProjectSessionTerminal(
            projectId,
            parameters.sessionId,
            parameters.terminalId,
            () => submit(parameters, signal),
        );
    };
}
