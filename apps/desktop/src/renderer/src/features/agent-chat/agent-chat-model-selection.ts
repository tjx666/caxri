import type { AgentChatModel, AgentChatModelRequest, AgentChatSnapshot } from '@caxri/protocol';
import { agentChatEffortLabel, findAgentChatModel } from '@caxri/protocol';

import type { Translate } from '../../i18n';
import { isTranslationKey, translate } from '../../i18n';

/**
 * The model picker's optimistic state. A switch takes a round trip through Server Core and the provider, and the picker
 * used to keep showing the old choice until the projection caught up, which read as the click being ignored. The picker
 * now shows the requested choice at once, with a spinner, until the snapshot settles it.
 */
export interface AgentChatPendingSelection {
    change: AgentChatModelRequest;
    /**
     * The model, effort, ultracode, and Fast mode the snapshot reported when the switch was requested.
     */
    baseline: {
        model: string | undefined;
        effort: string | undefined;
        ultracode?: boolean;
        fast?: boolean;
    };
    /**
     * Server Core accepted the switch, so any change in the reported model or effort is its answer, even one that does
     * not spell the requested identifier (an alias that resolves to another id).
     */
    isAccepted: boolean;
}

type SelectionSnapshot = Pick<
    AgentChatSnapshot,
    'effort' | 'fast' | 'model' | 'models' | 'ultracode'
>;

/**
 * Whether the snapshot now answers the pending switch: it reports the requested model, effort, ultracode, and Fast
 * mode, or, once the switch was accepted, it changed from the baseline at all.
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
    const isFastConfirmed = change.fast === undefined || snapshot?.fast === change.fast;
    if (isModelConfirmed && isEffortConfirmed && isUltracodeConfirmed && isFastConfirmed)
        return true;
    return (
        pending.isAccepted &&
        (snapshot?.model !== pending.baseline.model ||
            snapshot?.effort !== pending.baseline.effort ||
            snapshot?.ultracode !== pending.baseline.ultracode ||
            snapshot?.fast !== pending.baseline.fast)
    );
}

/**
 * The snapshot as the picker shows it while a switch is pending. A new model keeps the current effort when it offers
 * it, and otherwise shows its default, which is what the provider applies; a new model without Fast mode shows it off,
 * as the Server turns it off (`resolveAgentChatModelChange`).
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
    let fast = change.fast ?? snapshot.fast;
    if (fast && change.model !== undefined && change.fast === undefined) {
        const next = findAgentChatModel(snapshot.models, change.model);
        if (next && !next.fast) fast = false;
    }
    return {
        ...snapshot,
        model,
        effort,
        ...(ultracode !== undefined && { ultracode }),
        ...(fast !== undefined && { fast }),
    };
}

/**
 * The toast title for a failed switch, naming what the user tried to change.
 */
export function agentChatConfigureFailureMessage(change: AgentChatModelRequest): string {
    if (change.model !== undefined) return translate('agentChat.model.switchModelFailed');
    if (change.effort !== undefined) return translate('agentChat.model.switchEffortFailed');
    if (change.fast !== undefined)
        return translate(
            change.fast ? 'agentChat.model.fastOnFailed' : 'agentChat.model.fastOffFailed',
        );
    return translate(
        change.ultracode
            ? 'agentChat.model.ultracodeOnFailed'
            : 'agentChat.model.ultracodeOffFailed',
    );
}

/**
 * The display name of one effort level. The known levels are translated; an effort id the protocol does not name keeps
 * `agentChatEffortLabel`'s capitalized fallback.
 */
export function agentChatEffortDisplayName(t: Translate, effort: string): string {
    const key = `agentChat.model.effort.${effort}`;
    return isTranslationKey(key) ? t(key) : agentChatEffortLabel(effort);
}

/**
 * The listed model the menu checks and offers efforts for. Claude Code names the model in use only with a turn's init
 * message, so a new Chat reports none while the trigger already reads "Default" with the effort it will apply; the
 * provider's `default` alias is that model, so the menu checks it and shows its efforts instead of an unchecked list.
 */
export function agentChatMenuModel(
    snapshot: Pick<AgentChatSnapshot, 'model' | 'models'>,
): AgentChatModel | undefined {
    if (snapshot.model === undefined)
        return snapshot.models?.find((candidate) => candidate.id === 'default');
    return findAgentChatModel(snapshot.models, snapshot.model);
}

/**
 * Whether the menu offers the Fast mode toggle: the provider reports Fast mode for this Chat and the model the menu
 * checks lists it.
 */
export function isAgentChatFastOffered(
    snapshot: Pick<AgentChatSnapshot, 'fast'>,
    model: AgentChatModel | undefined,
): boolean {
    return snapshot.fast !== undefined && model?.fast !== undefined;
}

/**
 * The trigger's visible model and effort words plus its accessible name. `agentChatModelLabel` names an unreported
 * model "Default"; a listed model's name is the provider's own and stays as reported.
 */
export function agentChatModelTriggerText(
    t: Translate,
    snapshot: Pick<AgentChatSnapshot, 'effort' | 'fast' | 'model' | 'ultracode'> | undefined,
    label: { model: string; effort?: string },
): { modelName: string; effortName: string | undefined; ariaLabel: string } {
    const modelName = snapshot?.model ? label.model : t('agentChat.model.default');
    const effortName =
        label.effort && snapshot?.effort
            ? agentChatEffortDisplayName(t, snapshot.effort)
            : label.effort;
    const ariaLabel = [
        t('agentChat.model.triggerLabel', { model: modelName }),
        effortName ? t('agentChat.model.triggerEffort', { effort: effortName }) : '',
        snapshot?.ultracode ? t('agentChat.model.triggerUltracode') : '',
        snapshot?.fast ? t('agentChat.model.triggerFast') : '',
    ].join('');
    return { modelName, effortName, ariaLabel };
}
