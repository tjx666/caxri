import type { Principal } from '@caxri/protocol';
import { CaxriError } from '@caxri/protocol';

import type { AgentEndpointLifecycle } from './agent-endpoints';
import type { AgentTimelineService, AgentTranscriptWatcher } from './agents';
import type { ConfigService } from './config';
import type { CaxriDatabase } from './db';
import type { DomainHandlers } from './domain-services';
import { createMobileAgentAvailabilityHandler } from './mobile-agent-availability';
import { createMobileAgentSubmitHandler } from './mobile-agent-submit';
import type { MobileTerminalMutationQueue } from './mobile-terminal-mutation-queue';
import type { TerminalManager } from './terminal';

type MobileDomainMethods = Pick<
    DomainHandlers,
    | 'mobile.agent.availability'
    | 'mobile.agent.availabilityInternal'
    | 'mobile.agent.submit'
    | 'mobile.agent.submitInternal'
    | 'mobile.session.show'
    | 'mobile.timeline.read'
    | 'mobile.timeline.readInternal'
    | 'mobile.timeline.watchInternal'
    | 'mobile.timeline.unwatchInternal'
>;

function authorizedSession(database: CaxriDatabase, sessionId: string, principal: Principal) {
    if (principal.kind !== 'paired-device')
        throw new CaxriError('FORBIDDEN', 'Paired device is required');
    const session = database.getSession(sessionId);
    if (
        !session ||
        !principal.projectIds.includes(session.projectId) ||
        database.listVisibleProjects().every((project) => project.id !== session.projectId)
    )
        throw new CaxriError('NOT_FOUND', 'Session not found');
    return session;
}

export function createMobileDomainHandlers(options: {
    configuration: ConfigService;
    database: CaxriDatabase;
    endpoints?: AgentEndpointLifecycle;
    queue: MobileTerminalMutationQueue;
    terminals: TerminalManager;
    timeline: AgentTimelineService;
    transcripts: AgentTranscriptWatcher;
}): MobileDomainMethods {
    return {
        'mobile.agent.availability': () => {
            throw new CaxriError('FORBIDDEN', 'Mobile Agent availability requires a paired device');
        },
        'mobile.agent.availabilityInternal': createMobileAgentAvailabilityHandler(options),
        'mobile.agent.submit': () => {
            throw new CaxriError('FORBIDDEN', 'Mobile Agent input requires a paired device');
        },
        'mobile.agent.submitInternal': createMobileAgentSubmitHandler(options),
        'mobile.session.show': () => {
            throw new CaxriError('FORBIDDEN', 'Mobile Session view requires a paired device');
        },
        'mobile.timeline.read': () => {
            throw new CaxriError('FORBIDDEN', 'Mobile timeline requires a paired device');
        },
        'mobile.timeline.readInternal': async ({ sessionId, before, limit, principal }) => {
            const session = authorizedSession(options.database, sessionId, principal);
            const terminalId = session.primaryAgentTerminalId;
            if (!terminalId)
                return {
                    status: options.database
                        .listTerminals(sessionId)
                        .some((terminal) => terminal.kind === 'shell')
                        ? ('unsupported' as const)
                        : ('missing' as const),
                    items: [],
                    truncated: false,
                    cursorExpired: false,
                };
            return options.timeline.read(sessionId, terminalId, before, limit);
        },
        'mobile.timeline.watchInternal': async ({ sessionId, principal }) => {
            const session = authorizedSession(options.database, sessionId, principal);
            const terminalId = session.primaryAgentTerminalId;
            if (terminalId) await options.transcripts.watchMobile(terminalId);
            return { ...(terminalId && { terminalId }) };
        },
        'mobile.timeline.unwatchInternal': ({ terminalId }) => {
            options.transcripts.unwatchMobile(terminalId);
            return null;
        },
    };
}
