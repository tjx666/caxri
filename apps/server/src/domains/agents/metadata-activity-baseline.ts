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
