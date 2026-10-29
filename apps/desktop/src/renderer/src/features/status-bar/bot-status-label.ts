import type { BotRunState } from '@caxri/protocol';

import type { Translate } from '../../i18n';
import { formatCount } from '../../lib/locale-format';

export interface BotStatusChipCopy {
    /**
     * The chip's visible text, short enough for the crowded actions rail.
     */
    text: string;
    /**
     * Accessible name and tooltip: what Caxri Bot is doing, and where to open or stop it.
     */
    description: string;
}

/**
 * The chip's copy while Caxri Bot runs in the background, or undefined when it is stopped. A stopped Caxri Bot shows
 * nothing: View > Open Caxri Bot already starts it, so a "stopped" chip would only add noise.
 */
export function botStatusChipCopy(state: BotRunState, t: Translate): BotStatusChipCopy | undefined {
    if (state === 'stopped') return undefined;
    return {
        text: t(`statusBar.bot.${state}.text`),
        description: t(`statusBar.bot.${state}.description`),
    };
}

/**
 * The Inbox chip's copy for `count` open items, or undefined at zero: an empty Inbox holds no slot. The Inbox column is
 * titled "Needs you" in the Caxri Bot window, so the chip reuses that phrase.
 */
export function botInboxChipCopy(count: number, t: Translate): BotStatusChipCopy | undefined {
    if (count <= 0) return undefined;
    const parameters = { count: formatCount(count, t.locale) };
    return count === 1
        ? {
              text: t('statusBar.botInbox.textOne', parameters),
              description: t('statusBar.botInbox.descriptionOne', parameters),
          }
        : {
              text: t('statusBar.botInbox.textOther', parameters),
              description: t('statusBar.botInbox.descriptionOther', parameters),
          };
}
