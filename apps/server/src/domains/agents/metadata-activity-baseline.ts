import type { AgentActivityState, AgentSnapshot, SessionAttentionKind } from '@caxri/protocol';

export interface MetadataActivityBaseline {
    attentionKind?: SessionAttentionKind;
    status: AgentActivityState;
}

/**
 * Captures only fields that can advance Session Activity; titles and provider identity remain ordinary metadata.
 */
export function metadataActivityBaseline(snapshot: AgentSnapshot): MetadataActivityBaseline {
    return {
        attentionKind: snapshot.attentionKind,
        status: snapshot.status,
    };
}

/**
 * A repeated reconciliation snapshot is not evidence that work progressed after the baseline was established.
 */
export function isMetadataActivityBaselineMatch(
    baseline: MetadataActivityBaseline,
    snapshot: AgentSnapshot,
): boolean {
    return baseline.status === snapshot.status && baseline.attentionKind === snapshot.attentionKind;
}

/**
 * A process-only `unknown` baseline may update identity, title, and usage, but it cannot replace durable settled or
 * attention state. Uncorroborated `running` is cleared because interactive Agent CLIs stay alive at their prompt and
 * older builds persisted process liveness as false turn evidence.
 */
export function reconcileMetadataActivityBaseline(
    snapshot: AgentSnapshot,
    currentStatus: AgentActivityState,
): AgentSnapshot {
    const reconciledStatus =
        snapshot.status === 'unknown'
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
