import type { DelegationSelection } from '@caxri/protocol';

import { useTranslation } from '../../i18n';
import { delegationPresetDetail } from './delegation-preset';

/**
 * The name of the preset a delegated task was admitted with. It is plain text, never an interactive element, because it
 * sits inside a row that is itself a button. The provider, model and effort are the chip's screen-reader text, so they
 * join the row's accessible name; sighted users get the same details from the row's tooltip, which also opens on
 * keyboard focus. Renders nothing for a task started without a preset.
 */
export function DelegationPresetChip({
    isDetailVisible = false,
    selection,
}: {
    /**
     * Prints the provider, model and effort after the name, for a row with no tooltip to carry them.
     */
    isDetailVisible?: boolean;
    selection: DelegationSelection | undefined;
}) {
    const { t } = useTranslation();
    const detail = delegationPresetDetail(selection, t);
    if (!detail || !selection?.preset) return null;
    return (
        <span
            className="shrink-0 rounded-sm bg-list-hover-background px-1 text-[11px]"
            data-delegation-preset={selection.preset}
        >
            {selection.preset}
            <span className={isDetailVisible ? undefined : 'sr-only'}>{`: ${detail}`}</span>
        </span>
    );
}
