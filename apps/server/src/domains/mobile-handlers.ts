import { CaxriError } from '@caxri/protocol';

import type { AgentEndpointLifecycle } from './agent-endpoints';
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
>;

export function createMobileDomainHandlers(options: {
    configuration: ConfigService;
    database: CaxriDatabase;
    endpoints?: AgentEndpointLifecycle;
    queue: MobileTerminalMutationQueue;
    terminals: TerminalManager;
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
    };
}
