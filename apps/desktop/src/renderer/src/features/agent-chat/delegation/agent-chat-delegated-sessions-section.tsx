import { useId, useState } from 'react';

import { Forward } from 'lucide-react';

import { DisclosureMotion } from '../../../components/disclosure-motion';
import { useClockTick } from '../../../hooks/use-clock-tick';
import { useTranslation } from '../../../i18n';
import { cn } from '../../../lib/utilities';
import { isPrimarySidebarShown, useChromeLayoutStore } from '../../../stores/chrome-layout';
import { useSessionPullRequestPoll } from '../../primary-sidebar/hooks/use-session-pull-request';
import { AgentChatStripFoldedToggle } from '../composer/strip/agent-chat-strip-folded-toggle';
import {
    toggleAgentChatStripFold,
    useIsAgentChatStripSectionCollapsed,
} from '../composer/strip/agent-chat-strip-folds';
import { AgentChatStripSection } from '../composer/strip/agent-chat-strip-section';
import { AgentChatDelegatedSessionRow } from './agent-chat-delegated-session-row';
import {
    delegatedSessionsHeaderParts,
    delegatedSessionsSummary,
    splitDelegatedSessions,
} from './agent-chat-delegated-sessions';
import {
    delegatedCostLabel,
    delegatedHeaderFigure,
    sumDelegatedCost,
} from './cost/agent-chat-delegated-cost';
import { AgentChatDelegatedCostBadge } from './cost/agent-chat-delegated-cost-badge';
import { useChatDelegatedSessions } from './hooks/use-chat-delegated-sessions';
import { useDelegatedCost } from './hooks/use-delegated-cost';

/**
 * Keeps the pull request snapshot fresh for the rows of a Chat whose sidebar is hidden. The Project tree owns that poll
 * while it is mounted; with the sidebar closed nothing else does, and a finished task's pull request would go stale.
 */
function DelegatedPullRequestPoll() {
    useSessionPullRequestPoll();
    return null;
}

/**
 * The header text after the label: the count, then each attention part tinted by what it asks of the user, then the
 * partial-feed marker and the delegated cost.
 */
function DelegatedHeaderMeta({
    asking,
    cost,
    count,
    failed,
    headerCost,
    isPartial,
    needsInput,
    sessionId,
    waiting,
}: {
    asking?: string;
    cost: ReturnType<typeof useDelegatedCost>;
    count: string;
    failed?: string;
    headerCost: ReturnType<typeof delegatedCostLabel>;
    isPartial: boolean;
    needsInput?: string;
    sessionId?: string;
    waiting?: string;
}) {
    const { t } = useTranslation();
    return (
        <>
            {count}
            {needsInput && <span className="text-warning">{` · ${needsInput}`}</span>}
            {failed && <span className="text-danger">{` · ${failed}`}</span>}
            {waiting && <span>{` · ${waiting}`}</span>}
            {asking && <span>{` · ${asking}`}</span>}
            {isPartial && <span>{` · ${t('delegation.strip.more')}`}</span>}
            {headerCost && cost && sessionId && (
                <>
                    {' · '}
                    <AgentChatDelegatedCostBadge
                        delegatedCostUsd={cost.delegatedCostUsd}
                        delegatedIsActive={cost.isActive}
                        delegatedIsPartial={cost.isPartial}
                        delegatedSessions={cost.delegatedSessions}
                        label={headerCost}
                        sessionId={sessionId}
                    />
                </>
            )}
        </>
    );
}

/**
 * The "Delegated Sessions" section of the composer strip: one row per child Session this Chat's Agent delegated to,
 * consulted, or handed off to, under a header that counts them and states how many need input or failed. A completed
 * task stays in the list for a while after it completes (`splitDelegatedSessions`), then waits behind the header's
 * `Completed N` toggle, so the rows in view are the ones still worth looking at. The clock that folds a row only ticks
 * while a recent completed row is in view. Mounts only when the feed has entries, and only for a Chat on screen: a
 * kept-alive Chat in the background reads no feed, so the progress events that patch it cost the visible Chat alone
 * (the hidden-Chat render budget).
 */
export function AgentChatDelegatedSessionsSection({ terminalId }: { terminalId: string }) {
    const { t } = useTranslation();
    const { attempts, chainSessionIds, entries, isPartial, sessionId, total, viaBySessionId } =
        useChatDelegatedSessions(terminalId);
    const cost = useDelegatedCost(sessionId, total > 0);
    const isSidebarShown = useChromeLayoutStore(isPrimarySidebarShown);
    const [isShowingCompleted, setShowingCompleted] = useState(false);
    const isCollapsed = useIsAgentChatStripSectionCollapsed(terminalId, 'delegated');
    const completedListId = useId();
    const [needsClock, setNeedsClock] = useState(false);
    const now = useClockTick('minute', needsClock);
    const { folded, hasRecentCompleted, shown } = splitDelegatedSessions(entries, now);
    // Adjusting state during render: the clock runs only while a shown row still has to fold on time.
    if (needsClock !== hasRecentCompleted) setNeedsClock(hasRecentCompleted);
    // A later fold starts hidden again once the last folded row left, rather than appearing already expanded.
    if (isShowingCompleted && folded.length === 0) setShowingCompleted(false);
    if (entries.length === 0) return null;
    const summary = delegatedSessionsSummary(entries, total);
    const { asking, count, failed, needsInput, waiting } = delegatedSessionsHeaderParts(summary, t);
    const attention = [needsInput, failed, waiting].filter((part) => part !== undefined);
    const hasCompleted = entries.some((entry) => entry.status === 'completed');
    const announcement = [count, ...attention, ...(asking ? [asking] : [])].join(', ');
    const headerFigure = delegatedHeaderFigure(cost);
    const headerCost = delegatedCostLabel(headerFigure, t);
    const renderRow = (entry: (typeof entries)[number]) => (
        <AgentChatDelegatedSessionRow
            attempt={
                entry.delegationId === undefined ? undefined : attempts.get(entry.delegationId)
            }
            cost={delegatedCostLabel(
                cost &&
                    sumDelegatedCost(
                        chainSessionIds.get(entry.sessionId) ?? [entry.sessionId],
                        cost.children,
                    ),
                t,
            )}
            entry={entry}
            key={entry.sessionId}
            parentSessionId={sessionId}
            viaSessionId={viaBySessionId.get(entry.sessionId)}
        />
    );
    return (
        <>
            <span aria-live="polite" className="sr-only" role="status">
                {attention.join(', ')}
            </span>
            {hasCompleted && !isSidebarShown && <DelegatedPullRequestPoll />}
            <AgentChatStripSection
                ariaLabel={[
                    `${t('delegation.strip.label')}, ${announcement}`,
                    headerCost?.description,
                ]
                    .filter(Boolean)
                    .join(', ')}
                glyph={<Forward aria-hidden="true" className="size-3.5 shrink-0" />}
                label={t('delegation.strip.label')}
                meta={
                    <DelegatedHeaderMeta
                        asking={asking}
                        cost={cost}
                        count={count}
                        failed={failed}
                        headerCost={headerCost}
                        isPartial={isPartial}
                        needsInput={needsInput}
                        sessionId={sessionId}
                        waiting={waiting}
                    />
                }
                actions={
                    folded.length > 0 && (
                        <AgentChatStripFoldedToggle
                            hideLabel={t('delegation.strip.hideCompleted')}
                            isShowing={isShowingCompleted && !isCollapsed}
                            label={t('delegation.strip.completedCount', { count: folded.length })}
                            listId={completedListId}
                            showLabel={t('delegation.strip.showCompleted')}
                            onToggle={() => {
                                // A collapsed section unfolds with the completed rows in view, as `Ended N` does.
                                if (isCollapsed) {
                                    toggleAgentChatStripFold(terminalId, 'delegated');
                                    setShowingCompleted(true);
                                } else setShowingCompleted((value) => !value);
                            }}
                        />
                    )
                }
                section="delegated"
                terminalId={terminalId}
            >
                <ul className="m-0 flex max-h-48 list-none flex-col overflow-y-auto overscroll-contain p-0">
                    {shown.map(renderRow)}
                    {folded.length > 0 && (
                        <li className="list-none">
                            <DisclosureMotion
                                animate
                                expanded={isShowingCompleted}
                                id={completedListId}
                                kind="agent-chat-delegated-completed"
                            >
                                <ul
                                    aria-label={t('delegation.strip.completedList')}
                                    className={cn(
                                        'm-0 flex list-none flex-col p-0',
                                        shown.length > 0 &&
                                            'mt-1 border-0 border-t border-solid border-border pt-1',
                                    )}
                                >
                                    {folded.map(renderRow)}
                                </ul>
                            </DisclosureMotion>
                        </li>
                    )}
                </ul>
            </AgentChatStripSection>
        </>
    );
}
