import type { AgentActivityState } from '@caxri/protocol';
import type { StructuredLogger } from '@caxri/system';
import { logEventCatalog } from '@caxri/system';

import type { CaxriDatabase } from '../db';
import type { AgentLifecyclePhase } from './hooks/contract';

/**
 * Which write path changed durable Session activity: a live hook, a hook completion released later, or a probe.
 */
export type SessionActivitySource = 'deferredHook' | 'hook' | 'probe';

/**
 * A Session's durable activity state changed from one value to another.
 */
export interface SessionActivityTransition {
    sessionId: string;
    from: AgentActivityState;
    to: AgentActivityState;
}

export interface SessionActivityWrite {
    /**
     * Performs the durable write and reports whether anything changed.
     */
    applyWrite(): boolean;
    phase?: AgentLifecyclePhase;
    source: SessionActivitySource;
    terminalId: string;
}

/**
 * Wraps one durable Session activity write so every transition is logged at the moment it happens, with the path that
 * caused it. Activity and attention are otherwise only visible as the current state, which cannot explain a
 * notification after the fact or show how often each path fires. Only content-free identifiers and enums are logged.
 * `onTransition` hears every change of the activity state itself (an attention-only change is not one).
 */
export function hasSessionActivityChanged(
    database: Pick<CaxriDatabase, 'getSession' | 'getTerminal'>,
    logger: Pick<StructuredLogger, 'write'>,
    write: SessionActivityWrite,
    onTransition?: (transition: SessionActivityTransition) => void,
): boolean {
    const terminal = database.getTerminal(write.terminalId);
    const before = terminal && database.getSession(terminal.sessionId);
    const hasChanged = write.applyWrite();
    if (!hasChanged || !terminal || !before) return hasChanged;
    const after = database.getSession(terminal.sessionId);
    if (
        !after ||
        (after.lastActivityState === before.lastActivityState &&
            after.attentionEpoch === before.attentionEpoch &&
            after.readAttentionEpoch === before.readAttentionEpoch)
    )
        return hasChanged;
    logger.write('info', logEventCatalog.agent.sessionActivityChanged, {
        fields: {
            attentionEpoch: after.attentionEpoch,
            attentionKind: after.lastAttentionKind ?? null,
            from: before.lastActivityState,
            phase: write.phase ?? null,
            provider: terminal.provider ?? null,
            readAttentionEpoch: after.readAttentionEpoch,
            sessionId: after.id,
            source: write.source,
            terminalId: write.terminalId,
            to: after.lastActivityState,
        },
    });
    if (after.lastActivityState !== before.lastActivityState)
        onTransition?.({
            sessionId: after.id,
            from: before.lastActivityState,
            to: after.lastActivityState,
        });
    return hasChanged;
}
