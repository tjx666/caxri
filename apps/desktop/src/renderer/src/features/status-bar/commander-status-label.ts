import type { CommanderRunState } from '@caxri/protocol';

import type { Translate } from '../../i18n';
import { translate } from '../../i18n';
import { formatCount } from '../../lib/locale-format';

export interface CommanderStatusChipCopy {
    /**
     * The chip's visible text, short enough for the crowded actions rail.
     */
    text: string;
    /**
     * Accessible name and tooltip: what the Commander is doing, and where to open or stop it.
     */
    description: string;
}

/**
 * The chip's copy while the Commander runs in the background, or undefined when it is stopped. A stopped Commander
 * shows nothing: View > Open Agent Commander already starts it, so a "stopped" chip would only add noise.
 */
export function commanderStatusChipCopy(
    state: CommanderRunState,
    t: Translate = translate,
): CommanderStatusChipCopy | undefined {
    if (state === 'stopped') return undefined;
    return {
        text: t(`statusBar.commander.${state}.text`),
        description: t(`statusBar.commander.${state}.description`),
    };
}

/**
 * The Inbox chip's copy for `count` open items, or undefined at zero: an empty Inbox holds no slot. The Inbox column is
 * titled "Needs you" in the Agent Commander window, so the chip reuses that phrase.
 */
export function commanderInboxChipCopy(
    count: number,
    t: Translate = translate,
): CommanderStatusChipCopy | undefined {
    if (count <= 0) return undefined;
    const parameters = { count: formatCount(count) };
    return count === 1
        ? {
              text: t('statusBar.commanderInbox.textOne', parameters),
              description: t('statusBar.commanderInbox.descriptionOne', parameters),
          }
        : {
              text: t('statusBar.commanderInbox.textOther', parameters),
              description: t('statusBar.commanderInbox.descriptionOther', parameters),
          };
}
