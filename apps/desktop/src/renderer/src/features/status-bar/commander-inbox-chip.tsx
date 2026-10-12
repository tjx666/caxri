import { MessageSquareWarning } from 'lucide-react';

import { usePolledQuery } from '@/hooks/use-polled-query';

import { executeCommand } from '../../commands/execute';
import { useTranslation } from '../../i18n';
import { openCommanderInboxCount } from '../agent-commander/commander-inbox';
import { useCommanderManagedSessions } from '../agent-commander/hooks/use-commander-managed-sessions';
import { commanderInboxChipCopy } from './commander-status-label';
import { StatusItem } from './status-item';

/**
 * Low-frequency fallback only: `commanderInbox.changed` invalidates this read the moment the Inbox changes (see
 * `subscribeRuntimeQueryInvalidation`), so the interval only recovers from a missed event.
 */
const COMMANDER_INBOX_FALLBACK_REFETCH_INTERVAL_MS = 5 * 60_000;

/**
 * Open Agent Commander Inbox items ("Needs you") counted in the main window, which otherwise never shows that the
 * Commander is waiting on the user while its own window is closed. Muted like the other standing-mode chips: a question
 * waiting on the user is not a degradation (DESIGN.md status bar redline). Never priority-hidden, because the main
 * window has no other trace of it. Its glyph is the Commander window's own Inbox toggle glyph, so the chip and the
 * column it opens read as one thing.
 *
 * Also holds the Commander ownership feed: the status bar is the main window's always-mounted Commander surface, so the
 * notice that typing took a Session back from the Commander still arrives while the sidebar and its Session rows are
 * hidden.
 */
export function CommanderInboxChip() {
    const { t } = useTranslation();
    useCommanderManagedSessions();
    const { data } = usePolledQuery(
        'commander.inbox.list',
        {},
        {
            label: 'commander.inbox.list',
            intervalMs: COMMANDER_INBOX_FALLBACK_REFETCH_INTERVAL_MS,
        },
    );
    const copy = commanderInboxChipCopy(data ? openCommanderInboxCount(data.items) : 0, t);
    if (!copy) return null;
    return (
        <StatusItem
            icon={<MessageSquareWarning />}
            ariaLabel={copy.description}
            title={copy.description}
            className="commander-inbox-chip text-muted"
            onClick={() => executeCommand('agentCommander.open')}
        >
            {copy.text}
        </StatusItem>
    );
}
