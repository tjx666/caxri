import { usePolledQuery } from '../../../hooks/use-polled-query';
import { BOT_INBOX_QUERY_PARAMETERS } from '../bot-inbox-commands';

/**
 * A backstop only: `botInbox.changed` re-reads the Inbox as soon as it changes. The poll also moves each card's
 * relative time and picks up GitHub state the Server reconciled while this window was hidden.
 */
const INBOX_POLL_INTERVAL_MS = 30_000;

export function useBotInbox() {
    return usePolledQuery('bot.inbox.list', BOT_INBOX_QUERY_PARAMETERS, {
        intervalMs: INBOX_POLL_INTERVAL_MS,
        label: 'Bot Inbox',
    });
}
