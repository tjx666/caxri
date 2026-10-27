import { MessageSquareWarning } from 'lucide-react';

import { usePolledQuery } from '@/hooks/use-polled-query';

import { useTranslation } from '../../i18n';
import { openBotInbox } from '../caxri-bot/bot-commands';
import { openBotInboxCount } from '../caxri-bot/bot-inbox';
import { useBotInboxUiStore } from '../caxri-bot/bot-inbox-store';
import { useBotManagedSessions } from '../caxri-bot/hooks/use-bot-managed-sessions';
import { botInboxChipCopy } from './bot-status-label';
import { StatusItem } from './status-item';

/**
 * Low-frequency fallback only: `botInbox.changed` invalidates this read the moment the Inbox changes (see
 * `subscribeRuntimeQueryInvalidation`), so the interval only recovers from a missed event.
 */
const BOT_INBOX_FALLBACK_REFETCH_INTERVAL_MS = 5 * 60_000;

/**
 * Open Bot Inbox items ("Needs you") counted in the main window, which otherwise never shows that Caxri Bot is waiting
 * on the user while its own window is closed. A click raises Caxri Bot with its Inbox open and the first open item
 * focused, even when the Inbox was hidden or the window is narrow enough to make it a drawer. Muted like the other
 * standing-mode chips: a question waiting on the user is not a degradation (DESIGN.md status bar redline). Never
 * priority-hidden, because the main window has no other trace of it. Its glyph is the Caxri Bot window's own Inbox
 * toggle glyph, so the chip and the column it opens read as one thing.
 *
 * Also holds Caxri Bot's ownership feed: the status bar is the main window's always-mounted Caxri Bot surface, so the
 * notice that typing took a Session back from Caxri Bot still arrives while the sidebar and its Session rows are
 * hidden.
 */
export function BotInboxChip() {
    const { t } = useTranslation();
    useBotManagedSessions();
    const { data } = usePolledQuery(
        'bot.inbox.list',
        {},
        {
            label: 'bot.inbox.list',
            intervalMs: BOT_INBOX_FALLBACK_REFETCH_INTERVAL_MS,
        },
    );
    const dismissingIds = useBotInboxUiStore((state) => state.dismissingIds);
    const copy = botInboxChipCopy(data ? openBotInboxCount(data.items, dismissingIds) : 0, t);
    if (!copy) return null;
    return (
        <StatusItem
            icon={<MessageSquareWarning />}
            ariaLabel={copy.description}
            title={copy.description}
            className="bot-inbox-chip text-muted"
            onClick={openBotInbox}
        >
            {copy.text}
        </StatusItem>
    );
}
