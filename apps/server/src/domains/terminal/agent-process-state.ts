import type { ProcessState, ServerEvent } from '@caxri/protocol';

import type { TerminalLifecycleCause, TerminalManagerOptions } from './manager-types';
import type { TerminalStateStore } from './state-store';

/**
 * Persists a managed Agent's process state and announces it to the state observer and every Client. A Terminal deleted
 * meanwhile is skipped, so a late provider event never resurrects its record.
 */
export class AgentProcessStateEmitter {
    constructor(
        private readonly database: TerminalStateStore,
        private readonly emit: (event: ServerEvent) => void,
        private readonly onAgentStateChanged?: TerminalManagerOptions['onAgentStateChanged'],
    ) {}

    change(terminalId: string, state: ProcessState, cause?: TerminalLifecycleCause): void {
        if (!this.database.getTerminal(terminalId)) return;
        this.database.updateAgentProcessState(terminalId, state);
        this.onAgentStateChanged?.(terminalId, state, cause);
        this.emit({
            event: 'state.changed',
            payload: { kind: 'records', sessionIds: [], terminalIds: [terminalId] },
        });
    }

    /**
     * The exit variant also reports the Session whose activity the exit changed.
     */
    exit(terminalId: string, state: 'dead' | 'stopped'): void {
        if (!this.database.getTerminal(terminalId)) return;
        const changedSessionId = this.database.updateAgentProcessExitState(terminalId, state);
        this.onAgentStateChanged?.(terminalId, state);
        this.emit({
            event: 'state.changed',
            payload: {
                kind: 'records',
                sessionIds: changedSessionId ? [changedSessionId] : [],
                terminalIds: [terminalId],
            },
        });
    }
}
