import type { AgentActivityState, SessionAttentionKind } from '@caxri/protocol';

import type { AgentProbeSnapshot } from './contract';

export interface MetadataActivityBaseline {
    activityTurnId?: string;
    attentionKind?: SessionAttentionKind;
    status: AgentActivityState;
}

/**
 * Captures only fields that can advance Session Activity; titles and provider identity remain ordinary metadata.
 */
export function metadataActivityBaseline(snapshot: AgentProbeSnapshot): MetadataActivityBaseline {
    return {
        activityTurnId: snapshot.activityTurnId,
        attentionKind: snapshot.attentionKind,
        status: snapshot.status,
    };
}

/**
 * A repeated reconciliation snapshot is not evidence that work progressed after the baseline was established.
 */
export function isMetadataActivityBaselineMatch(
    baseline: MetadataActivityBaseline,
    snapshot: AgentProbeSnapshot,
): boolean {
    return (
        baseline.status === snapshot.status &&
        baseline.attentionKind === snapshot.attentionKind &&
        baseline.activityTurnId === snapshot.activityTurnId
    );
}

/**
 * A process-only `unknown` or a Codex latest-turn `running` baseline may update identity, title, and usage, but it
 * cannot replace durable settled or attention state. Codex can retain an in-progress row after an abnormal process
 * exit; other providers' generation-validated running metadata remains reliable and must pass through.
 */
export function reconcileMetadataActivityBaseline(
    snapshot: AgentProbeSnapshot,
    currentStatus: AgentActivityState,
): AgentProbeSnapshot {
    const reconciledStatus =
        snapshot.status === 'unknown' ||
        (snapshot.status === 'running' && snapshot.activitySource === 'latestTurn')
            ? currentStatus === 'running'
                ? 'unknown'
                : currentStatus
            : snapshot.status;
    return {
        ...snapshot,
        attentionKind: undefined,
        status: reconciledStatus,
    };
}
