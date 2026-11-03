import { Forward } from 'lucide-react';

import { useClockTick } from '@/hooks/use-clock-tick';

import { useTranslation } from '../../../i18n';
import { isPrimarySidebarShown, useChromeLayoutStore } from '../../../stores/chrome-layout';
import { useSessionPullRequestPoll } from '../../primary-sidebar/hooks/use-session-pull-request';
import { AgentChatStripSection } from '../composer/strip/agent-chat-strip-section';
import { AgentChatDelegatedSessionRow } from './agent-chat-delegated-session-row';
import {
    delegatedSessionsHeaderParts,
    delegatedSessionsSummary,
} from './agent-chat-delegated-sessions';
import { useDelegatedSessions } from './hooks/use-delegated-sessions';

/**
 * Keeps the pull request snapshot fresh for the rows of a Chat whose sidebar is hidden. The Project tree owns that poll
 * while it is mounted; with the sidebar closed nothing else does, and a finished task's pull request would go stale.
 */
function DelegatedPullRequestPoll() {
    useSessionPullRequestPoll();
    return null;
}

/**
 * The "Delegated Sessions" section of the composer strip: one row per child Session this Chat's Agent delegated to,
 * consulted, or handed off to, under a header that counts them and states how many need input or failed. Mounts only
 * when the feed has entries, and only for a Chat on screen: a kept-alive Chat in the background reads no feed, so the
 * progress events that patch it cost the visible Chat alone (the hidden-Chat render budget).
 */
export function AgentChatDelegatedSessionsSection({ terminalId }: { terminalId: string }) {
    const { t } = useTranslation();
    const { attempts, entries } = useDelegatedSessions(terminalId);
    // A minute tick: it ages the elapsed labels and expires a reset time, and no row needs finer than that.
    const now = useClockTick('minute');
    const isSidebarShown = useChromeLayoutStore(isPrimarySidebarShown);
    if (entries.length === 0) return null;
    const summary = delegatedSessionsSummary(entries);
    const { count, failed, needsInput } = delegatedSessionsHeaderParts(summary, t);
    const attention = [needsInput, failed].filter((part) => part !== undefined);
    const hasCompleted = entries.some((entry) => entry.status === 'completed');
    const announcement = [count, ...attention].join(', ');
    return (
        <>
            <span aria-live="polite" className="sr-only" role="status">
                {attention.join(', ')}
            </span>
            {hasCompleted && !isSidebarShown && <DelegatedPullRequestPoll />}
            <AgentChatStripSection
                ariaLabel={`${t('delegation.strip.label')}, ${announcement}`}
                glyph={<Forward aria-hidden="true" className="size-3.5 shrink-0" />}
                label={t('delegation.strip.label')}
                meta={
                    <>
                        {count}
                        {needsInput && <span className="text-warning">{` · ${needsInput}`}</span>}
                        {failed && <span className="text-danger">{` · ${failed}`}</span>}
                    </>
                }
                section="delegated"
                terminalId={terminalId}
            >
                <ul className="m-0 flex max-h-48 list-none flex-col overflow-y-auto p-0">
                    {entries.map((entry) => (
                        <AgentChatDelegatedSessionRow
                            attempt={
                                entry.delegationId === undefined
                                    ? undefined
                                    : attempts.get(entry.delegationId)
                            }
                            entry={entry}
                            key={entry.sessionId}
                            now={now}
                        />
                    ))}
                </ul>
            </AgentChatStripSection>
        </>
    );
}
