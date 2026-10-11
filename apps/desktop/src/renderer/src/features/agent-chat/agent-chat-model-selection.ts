import type { AgentChatModelRequest, AgentChatSnapshot } from '@caxri/protocol';
import { findAgentChatModel } from '@caxri/protocol';

/**
 * The model picker's optimistic state. A switch takes a round trip through Server Core and the provider, and the picker
 * used to keep showing the old choice until the projection caught up, which read as the click being ignored. The picker
 * now shows the requested choice at once, with a spinner, until the snapshot settles it.
 */
export interface AgentChatPendingSelection {
    change: AgentChatModelRequest;
    /**
     * The model, effort, and ultracode the snapshot reported when the switch was requested.
     */
    baseline: { model: string | undefined; effort: string | undefined; ultracode?: boolean };
    /**
     * Server Core accepted the switch, so any change in the reported model or effort is its answer, even one that does
     * not spell the requested identifier (an alias that resolves to another id).
     */
    isAccepted: boolean;
}

type SelectionSnapshot = Pick<AgentChatSnapshot, 'effort' | 'model' | 'models' | 'ultracode'>;

/**
 * Whether the snapshot now answers the pending switch: it reports the requested model, effort, and ultracode, or, once
 * the switch was accepted, it changed from the baseline at all.
 */
export function isAgentChatSelectionSettled(
    pending: AgentChatPendingSelection,
    snapshot: SelectionSnapshot | undefined,
): boolean {
    const { change } = pending;
    const isModelConfirmed =
        change.model === undefined ||
        snapshot?.model === change.model ||
        findAgentChatModel(snapshot?.models, snapshot?.model)?.id === change.model;
    const isEffortConfirmed = change.effort === undefined || snapshot?.effort === change.effort;
    const isUltracodeConfirmed =
        change.ultracode === undefined || snapshot?.ultracode === change.ultracode;
    if (isModelConfirmed && isEffortConfirmed && isUltracodeConfirmed) return true;
    return (
        pending.isAccepted &&
        (snapshot?.model !== pending.baseline.model ||
            snapshot?.effort !== pending.baseline.effort ||
            snapshot?.ultracode !== pending.baseline.ultracode)
    );
}

/**
 * The snapshot as the picker shows it while a switch is pending. A new model keeps the current effort when it offers
 * it, and otherwise shows its default, which is what the provider applies.
 */
export function agentChatSelectionView<Snapshot extends SelectionSnapshot>(
    snapshot: Snapshot,
    pending: AgentChatPendingSelection | undefined,
): Snapshot {
    if (!pending) return snapshot;
    const { change } = pending;
    const model = change.model ?? snapshot.model;
    let effort = change.effort ?? snapshot.effort;
    if (change.model !== undefined && change.effort === undefined) {
        const next = findAgentChatModel(snapshot.models, change.model);
        if (next && (effort === undefined || !next.efforts.includes(effort)))
            effort = next.defaultEffort;
    }
    const ultracode = change.ultracode ?? snapshot.ultracode;
    return { ...snapshot, model, effort, ...(ultracode !== undefined && { ultracode }) };
}

/**
 * The toast title for a failed switch, naming what the user tried to change.
 */
export function agentChatConfigureFailureMessage(change: AgentChatModelRequest): string {
    if (change.model !== undefined) return 'Unable to switch the model';
    if (change.effort !== undefined) return 'Unable to switch the effort';
    return change.ultracode ? 'Unable to turn on Ultracode' : 'Unable to turn off Ultracode';
}
