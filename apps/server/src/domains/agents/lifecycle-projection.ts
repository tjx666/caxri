import type { ServerEvent } from '@caxri/protocol';
import type { StructuredLogger } from '@caxri/system';

import type { CaxriDatabase } from '../db';
import type { AgentAttentionTracker } from './attention-tracker';
import type { createRecoveringHookLaunchTracker } from './hook-launch-tracker';
import type { AgentLifecycleSignal } from './hooks/contract';
import type { AgentIdleProof } from './idle-proof';
import type { AgentLifecycleWatchdogs } from './lifecycle-watchdogs';
import type {
    SessionActivitySource,
    SessionActivityTransition,
    SessionActivityWrite,
} from './session-activity-log';
import { hasSessionActivityChanged } from './session-activity-log';

interface Options {
    idleProof: AgentIdleProof;
    attention: AgentAttentionTracker;
    watchdogs: AgentLifecycleWatchdogs;
    hookLaunches: ReturnType<typeof createRecoveringHookLaunchTracker>;
    onApplied?: (event: AgentLifecycleSignal) => void;
    onActivityChanged?: (transition: SessionActivityTransition) => void;
}

/**
 * Applies lifecycle cleanup and projects Session activity.
 */
export class AgentLifecycleProjection {
    /**
     * Requests whose release arrived before their quiet signal was applied (the coordinator registers a request only
     * after its async provenance step). The matching quiet signal is then written as a normal alert instead of being
     * skipped, so a held request is never left unalerted once it has escalated.
     */
    private readonly earlyReleases = new Set<string>();

    constructor(
        private readonly database: CaxriDatabase,
        private readonly logger: StructuredLogger,
        private readonly emit: (event: ServerEvent) => void,
        private readonly options: Options,
    ) {}

    private requestKey(event: AgentLifecycleSignal): string {
        return JSON.stringify([event.terminalId, event.agentId ?? '', event.agentToolUseId ?? '']);
    }

    private write(event: AgentLifecycleSignal, source: SessionActivitySource): void {
        if (
            this.recordActivity({
                applyWrite: () => this.database.updateAgentLifecycle(event),
                phase: event.phase,
                source,
                terminalId: event.terminalId,
            })
        )
            this.emitMetadataChange(event.terminalId);
    }

    private forgetEarlyReleases(terminalId: string): void {
        const prefix = `${JSON.stringify([terminalId]).slice(0, -1)},`;
        for (const key of this.earlyReleases)
            if (key.startsWith(prefix)) this.earlyReleases.delete(key);
    }

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

    /**
     * Performs one durable Session activity write, logging and reporting its transition (`hasSessionActivityChanged`).
     */
    recordActivity(write: SessionActivityWrite): boolean {
        return hasSessionActivityChanged(
            this.database,
            this.logger,
            write,
            this.options.onActivityChanged,
        );
    }

    apply(event: AgentLifecycleSignal, source: SessionActivitySource = 'hook'): void {
        const { idleProof, attention, watchdogs, hookLaunches } = this.options;
        idleProof.apply(event, source === 'hook');
        if (event.phase === 'turnFinished' || event.phase === 'turnFailed') {
            attention.forget(event.terminalId);
            this.forgetEarlyReleases(event.terminalId);
            watchdogs.stopRunningTurn(event.terminalId);
            hookLaunches.markAuthoritative(event.terminalId, event.launchId, event.agentTurnId);
        } else if (event.phase === 'attentionResolved')
            this.earlyReleases.delete(this.requestKey(event));
        const releasedEarly =
            event.phase === 'attentionRequested' &&
            event.alert === 'quiet' &&
            this.earlyReleases.delete(this.requestKey(event));
        if (releasedEarly) this.write({ ...event, alert: 'raise' }, source);
        else if (event.phase !== 'attentionRequested' || event.alert !== 'quiet')
            this.write(event, source);
        this.options.onApplied?.(event);
    }

    /**
     * Shows a held request to the user: the one Session record write a quiet `attentionRequested` skipped. Neither idle
     * proof nor `onApplied` runs again. False, and no write, unless the request is still tracked as pending, so a
     * request the provider already resolved never alerts.
     */
    raise(event: AgentLifecycleSignal): boolean {
        if (!this.options.attention.has(event)) {
            this.earlyReleases.add(this.requestKey(event));
            return false;
        }
        this.write({ ...event, alert: 'raise' }, 'hook');
        return true;
    }
}
