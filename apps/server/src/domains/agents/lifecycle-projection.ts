import type { ServerEvent } from '@caxri/protocol';
import type { StructuredLogger } from '@caxri/system';

import type { CaxriDatabase } from '../db';
import type { AgentAttentionTracker } from './attention-tracker';
import type { createRecoveringHookLaunchTracker } from './hook-launch-tracker';
import type { AgentLifecycleSignal } from './hooks/contract';
import type { AgentIdleProof } from './idle-proof';
import type { AgentLifecycleWatchdogs } from './lifecycle-watchdogs';
import type { SessionActivitySource } from './session-activity-log';
import { hasSessionActivityChanged } from './session-activity-log';

interface Options {
    idleProof: AgentIdleProof;
    attention: AgentAttentionTracker;
    watchdogs: AgentLifecycleWatchdogs;
    hookLaunches: ReturnType<typeof createRecoveringHookLaunchTracker>;
    onApplied?: (event: AgentLifecycleSignal) => void;
}

/**
 * Applies lifecycle cleanup and projects Session activity.
 */
export class AgentLifecycleProjection {
    constructor(
        private readonly database: CaxriDatabase,
        private readonly logger: StructuredLogger,
        private readonly emit: (event: ServerEvent) => void,
        private readonly options: Options,
    ) {}

    emitMetadataChange(terminalId: string): void {
        const terminal = this.database.getTerminal(terminalId);
        if (!terminal) return;
        this.emit({
            event: 'state.changed',
            payload: {
                kind: 'records',
                sessionIds: [terminal.sessionId],
                terminalIds: [terminal.id],
            },
        });
    }

    apply(event: AgentLifecycleSignal, source: SessionActivitySource = 'hook'): void {
        const { idleProof, attention, watchdogs, hookLaunches } = this.options;
        idleProof.apply(event, source === 'hook');
        if (event.phase === 'turnFinished' || event.phase === 'turnFailed') {
            attention.forget(event.terminalId);
            watchdogs.stopRunningTurn(event.terminalId);
            hookLaunches.markAuthoritative(event.terminalId, event.launchId, event.agentTurnId);
        }
        if (
            hasSessionActivityChanged(this.database, this.logger, {
                applyWrite: () => this.database.updateAgentLifecycle(event),
                phase: event.phase,
                source,
                terminalId: event.terminalId,
            })
        )
            this.emitMetadataChange(event.terminalId);
        this.options.onApplied?.(event);
    }
}
