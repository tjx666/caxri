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
function metadataActivityBaseline(snapshot: AgentProbeSnapshot): MetadataActivityBaseline {
    return {
        activityTurnId: snapshot.activityTurnId,
        attentionKind: snapshot.attentionKind,
        status: snapshot.status,
    };
}

/**
 * A repeated reconciliation snapshot is not evidence that work progressed after the baseline was established.
 */
function isMetadataActivityBaselineMatch(
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
function reconcileMetadataActivityBaseline(
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

/**
 * Decides what one probe may write to Session Activity. A hook-owned probe keeps the stored activity, as does a probe
 * during a maintenance compaction. The first probe of a launch or turn records a baseline that may reconcile but never
 * advance Session Activity; a later probe that differs from it is a real transition.
 */
export function probeActivity(
    baselines: Map<string, MetadataActivityBaseline | null>,
    terminalId: string,
    snapshot: AgentProbeSnapshot,
    activityState: AgentActivityState,
    isHookOwned: boolean,
): { isRecordActivity: boolean; metadataSnapshot: AgentProbeSnapshot } {
    const hasMetadataBaseline = baselines.has(terminalId);
    const activityBaseline = baselines.get(terminalId);
    const isBaselineReconciliation =
        !hasMetadataBaseline ||
        (activityBaseline !== null &&
            activityBaseline !== undefined &&
            isMetadataActivityBaselineMatch(activityBaseline, snapshot));
    if (!hasMetadataBaseline) baselines.set(terminalId, metadataActivityBaseline(snapshot));
    else if (!isBaselineReconciliation) baselines.set(terminalId, null);
    const metadataSnapshot = isHookOwned
        ? { ...snapshot, attentionKind: undefined, status: activityState }
        : isBaselineReconciliation
          ? reconcileMetadataActivityBaseline(snapshot, activityState)
          : snapshot;
    return { isRecordActivity: !isBaselineReconciliation && !isHookOwned, metadataSnapshot };
}
