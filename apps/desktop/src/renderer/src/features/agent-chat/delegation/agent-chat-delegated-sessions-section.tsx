import { Forward } from 'lucide-react';

import { useTranslation } from '../../../i18n';
import { isPrimarySidebarShown, useChromeLayoutStore } from '../../../stores/chrome-layout';
import { useSessionPullRequestPoll } from '../../primary-sidebar/hooks/use-session-pull-request';
import { AgentChatStripSection } from '../composer/strip/agent-chat-strip-section';
import { AgentChatDelegatedSessionRow } from './agent-chat-delegated-session-row';
import {
    delegatedSessionsHeaderParts,
    delegatedSessionsSummary,
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
 * The "Delegated Sessions" section of the composer strip: one row per child Session this Chat's Agent delegated to,
 * consulted, or handed off to, under a header that counts them and states how many need input or failed. Mounts only
 * when the feed has entries, and only for a Chat on screen: a kept-alive Chat in the background reads no feed, so the
 * progress events that patch it cost the visible Chat alone (the hidden-Chat render budget).
 */
export function AgentChatDelegatedSessionsSection({ terminalId }: { terminalId: string }) {
    const { t } = useTranslation();
    const { attempts, chainSessionIds, entries, isPartial, sessionId, total, viaBySessionId } =
        useChatDelegatedSessions(terminalId);
    const cost = useDelegatedCost(sessionId, total > 0);
    const isSidebarShown = useChromeLayoutStore(isPrimarySidebarShown);
    if (entries.length === 0) return null;
    const summary = delegatedSessionsSummary(entries, total);
    const { asking, count, failed, needsInput, waiting } = delegatedSessionsHeaderParts(summary, t);
    const attention = [needsInput, failed, waiting].filter((part) => part !== undefined);
    const hasCompleted = entries.some((entry) => entry.status === 'completed');
    const announcement = [count, ...attention, ...(asking ? [asking] : [])].join(', ');
    const headerFigure = delegatedHeaderFigure(cost);
    const headerCost = delegatedCostLabel(headerFigure, t);
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
                                    delegatedIsPartial={cost.isPartial}
                                    delegatedSessions={cost.delegatedSessions}
                                    label={headerCost}
                                    sessionId={sessionId}
                                />
                            </>
                        )}
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
                            viaSessionId={viaBySessionId.get(entry.sessionId)}
                        />
                    ))}
                </ul>
            </AgentChatStripSection>
        </>
    );
}
