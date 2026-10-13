import type { ProcessState } from '@caxri/protocol';

import type { TerminalLifecycleCause } from '../terminal';
import type { AgentDispatchService } from './service';

/**
 * Late-bound route from Agent process state changes to dispatch receipts. The Terminal Manager (PTY Agents) and the
 * Agent Chat service (Chat Agents) are composed before the dispatch service exists, so both report to this relay, which
 * forwards to `AgentDispatchService.observeTerminalState` once `service` is set.
 */
export class AgentDispatchStateRelay {
    service?: Pick<AgentDispatchService, 'observeTerminalState'>;

    readonly observe = (
        terminalId: string,
        state: ProcessState,
        cause?: TerminalLifecycleCause,
    ): void => {
        this.service?.observeTerminalState(terminalId, state, cause);
    };
}
