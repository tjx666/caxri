import type { AgentChatModel, AgentChatModelRequest, AgentChatSnapshot } from '@caxri/protocol';
import { agentChatEffortLabel, findAgentChatModel } from '@caxri/protocol';

import type { Translate } from '../../i18n';
import { isTranslationKey, translate } from '../../i18n';

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

/**
 * Which face the picker's popover shows: the effort panel (the slider with the mode toggles above it), or the model
 * list it opens from the model name.
 */
export type AgentChatModelPickerView = 'effort' | 'models';

/**
 * The face the picker opens on. A model without effort control and without a mode toggle has nothing for the effort
 * panel to set (Grok Build's models), so the picker goes straight to the model list.
 */
export function agentChatPickerOpeningView(
    model: AgentChatModel | undefined,
    hasModes: boolean,
): AgentChatModelPickerView {
    return hasModes || (model?.efforts.length ?? 0) > 0 ? 'effort' : 'models';
}

/**
 * The slider stop the effort sits on. An effort the model does not list (a provider that reported an unlisted level)
 * sits on the model's default, else the lowest stop, so the thumb never falls off the track.
 */
export function agentChatEffortStop(model: AgentChatModel, effort: string | undefined): number {
    const index = effort === undefined ? -1 : model.efforts.indexOf(effort);
    if (index !== -1) return index;
    const fallback = model.defaultEffort ? model.efforts.indexOf(model.defaultEffort) : -1;
    return Math.max(fallback, 0);
}

/**
 * The effort Reset to default switches to: the model's default, or nothing when the model names none or already uses
 * it, which disables the button.
 */
export function agentChatEffortReset(
    model: AgentChatModel,
    effort: string | undefined,
): string | undefined {
    const { defaultEffort } = model;
    if (!defaultEffort || defaultEffort === effort || !model.efforts.includes(defaultEffort))
        return undefined;
    return defaultEffort;
}
