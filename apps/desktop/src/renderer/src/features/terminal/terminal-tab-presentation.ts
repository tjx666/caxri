import type { TerminalRecord } from '@caxri/protocol';
import { isChatTerminal } from '@caxri/protocol';

import type { Translate } from '../../i18n';
import { translate } from '../../i18n';

/**
 * The hover title of a Terminal tab: its untruncated title, plus "(Chat)" for an Agent shown as a Chat. Only the active
 * tab carries the rail's Terminal | Chat switch, so without this an inactive tab gives no hint which view it opens to.
 * `WorkTab` speaks a tooltip that differs from the visible label in place of that label, so the same text is also the
 * tab's accessible name and screen readers hear the view too. No visible slot: the rail reserves none for it (DESIGN.md
 * principle 8).
 */
export function terminalTabTooltip(
    displayTitle: string,
    terminal: Pick<TerminalRecord, 'provider' | 'surface'>,
    t: Translate = translate,
): string {
    return terminal.provider && isChatTerminal(terminal)
        ? t('terminal.tab.chatTooltip', { title: displayTitle })
        : displayTitle;
}
