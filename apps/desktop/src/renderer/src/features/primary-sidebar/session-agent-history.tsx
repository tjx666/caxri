import type { SessionAgentHistoryEntry } from '@caxri/protocol';

import { useRelativeTime } from '@/hooks/use-relative-time';

import { useTranslation } from '../../i18n';
import { resolveAgentIcon } from '../../icons/agents/agent-icon-registry';
import { AgentIdentityIcon } from '../../icons/agents/agent-identity-icon';
import { useCaxriQuery } from '../../queries/client';
import { reopenSessionConversation } from './session-agent-history-commands';
import { hasReopenableConversation } from './session-agent-history-entries';

function SessionAgentHistoryRow({
    entry,
    onReopen,
}: {
    entry: SessionAgentHistoryEntry;
    onReopen: () => void;
}) {
    const { t } = useTranslation();
    const boundAt = useRelativeTime(entry.boundAt);
    const agentLabel = resolveAgentIcon(entry.provider).label;
    const title = entry.title ?? t('primarySidebar.card.history.untitled', { agent: agentLabel });
    const isOpen = entry.terminalId !== undefined;
    return (
        <li>
            <button
                type="button"
                className="session-agent-history-entry flex w-full cursor-pointer items-center gap-1.5 rounded border-0 bg-transparent px-1 py-1 text-left text-[11px] text-foreground hover:bg-state-hover focus-visible:ring-1 focus-visible:ring-foreground focus-visible:outline-none"
                aria-label={t(
                    isOpen
                        ? 'primarySidebar.card.history.showAriaLabel'
                        : 'primarySidebar.card.history.reopenAriaLabel',
                    { title, time: boundAt },
                )}
                data-open={isOpen || undefined}
                onClick={onReopen}
            >
                <AgentIdentityIcon identity={entry.provider} size={12} />
                <span className="min-w-0 flex-1 truncate">{title}</span>
                <span className="flex-none text-muted">
                    {isOpen ? t('primarySidebar.card.history.open') : boundAt}
                </span>
            </button>
        </li>
    );
}

/**
 * The Session hover card's list of every Agent conversation the Session hosted, read only while the card is open. One
 * whose Terminal was closed, or reused by `/clear` or a provider switch, comes back as a parked Terminal in this
 * Session; one still open is selected.
 */
export function SessionAgentHistory({
    isVisible,
    onReopen,
    sessionId,
}: {
    isVisible: boolean;
    /**
     * Closes the card once the user picked a conversation, so the Terminal it reveals is not covered.
     */
    onReopen: () => void;
    sessionId: string;
}) {
    const { t } = useTranslation();
    const { data } = useCaxriQuery(
        'session.agentHistory',
        { sessionId },
        { enabled: isVisible, staleTime: 0 },
    );
    if (!data || !hasReopenableConversation(data.entries)) return null;
    return (
        <div className="session-agent-history mt-2 text-[11px]">
            <span className="font-medium text-muted">{t('primarySidebar.card.history.title')}</span>
            <ul className="m-0 -mx-1 mt-0.5 list-none p-0">
                {data.entries.map((entry) => (
                    <SessionAgentHistoryRow
                        key={`${entry.provider}:${entry.agentSessionId}`}
                        entry={entry}
                        onReopen={() => {
                            onReopen();
                            void reopenSessionConversation(sessionId, entry);
                        }}
                    />
                ))}
            </ul>
        </div>
    );
}
