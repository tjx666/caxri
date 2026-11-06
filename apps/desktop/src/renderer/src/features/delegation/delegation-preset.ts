import type { DelegationSelection } from '@caxri/protocol';
import { agentProviderCatalog } from '@caxri/protocol';

import type { Translate } from '../../i18n';

/**
 * The name a delegated task was admitted under: its type in the interface language (`Review`), or its preset's own
 * name. `undefined` for a task started with an explicit provider.
 */
export function delegationSelectionLabel(
    selection: DelegationSelection | undefined,
    t: Translate,
): string | undefined {
    if (selection?.type) return t(`delegation.type.${selection.type}`);
    return selection?.preset;
}

/**
 * The provider, model and effort frozen on a delegated task's receipt, as one phrase (`Codex, gpt-5.5, high`). Reads
 * only that frozen selection; `undefined` for a task started without a type or preset.
 */
export function delegationPresetDetail(
    selection: DelegationSelection | undefined,
    t: Translate,
): string | undefined {
    if (!selection?.preset && !selection?.type) return undefined;
    return t('delegation.preset.detail', {
        provider: agentProviderCatalog[selection.provider].displayName,
        model: selection.model ?? t('delegation.preset.defaultModel'),
        effort: selection.effort ?? t('delegation.preset.defaultEffort'),
    });
}

/**
 * The preset a delegated task was admitted with, as one sentence: its name and the provider, model and effort frozen on
 * the task's receipt. It reads only that frozen selection, never the current settings, so a preset edited or removed
 * since still describes what the task actually ran with. `undefined` for a task started without a preset.
 */
export function delegationPresetSummary(
    selection: DelegationSelection | undefined,
    t: Translate,
): string | undefined {
    const detail = delegationPresetDetail(selection, t);
    if (detail === undefined) return undefined;
    if (selection?.type)
        return t('delegation.type.summary', {
            name: t(`delegation.type.${selection.type}`),
            detail,
        });
    return t('delegation.preset.summary', { name: selection!.preset!, detail });
}
