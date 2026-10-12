import { ListTodo } from 'lucide-react';

import { usePolledQuery } from '@/hooks/use-polled-query';

import { executeCommand } from '../../commands/execute';
import { openCommanderInboxCount } from '../agent-commander/commander-inbox';
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
 * window has no other trace of it.
 */
export function CommanderInboxChip() {
    const { data } = usePolledQuery(
        'commander.inbox.list',
        {},
        {
            label: 'commander.inbox.list',
            intervalMs: COMMANDER_INBOX_FALLBACK_REFETCH_INTERVAL_MS,
        },
    );
    const copy = commanderInboxChipCopy(data ? openCommanderInboxCount(data.items) : 0);
    if (!copy) return null;
    return (
        <StatusItem
            icon={<ListTodo />}
            ariaLabel={copy.description}
            title={copy.description}
            className="commander-inbox-chip text-muted"
            onClick={() => executeCommand('agentCommander.open')}
        >
            {copy.text}
        </StatusItem>
    );
}
