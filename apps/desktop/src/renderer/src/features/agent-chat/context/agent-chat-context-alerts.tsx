import type { AgentChatUsage } from '@caxri/protocol';
import { agentChatIdleCompactionAt, defaultAppSettings } from '@caxri/protocol';
import type { LucideIcon } from 'lucide-react';
import { Gauge, MessageSquarePlus, Timer, TimerOff, X } from 'lucide-react';

import { Button } from '../../../components/ui/button';
import { Spinner } from '../../../components/ui/spinner';
import { Tooltip } from '../../../components/ui/tooltip';
import { useTranslation } from '../../../i18n';
import { cn } from '../../../lib/utilities';
import { useWorkbenchStore } from '../../../stores/workbench';
import { useClockTick } from '../hooks/use-clock-tick';
import {
    agentChatContextAlerts,
    agentChatContextAnnouncement,
    agentChatContextRowState,
    agentChatUndismissedContextAlerts,
} from './agent-chat-context';
import {
    dismissAgentChatCacheNotice,
    useAgentChatCacheNoticeDismissals,
} from './agent-chat-context-dismissals';

/**
 * When Server Core's idle compaction will compact this Chat (`agentChatIdleCompactionAt`), or `undefined` when it will
 * not: the provider or context does not qualify, the Chat is not its Session's primary Agent or its provider is not
 * running (a suspended Chat is never woken to compact), or the user turned the setting off. Each selector returns a
 * primitive, so an unrelated Terminal or setting change does not re-render the composer.
 */
function useAgentChatIdleCompactionAt(
    terminalId: string,
    usage: AgentChatUsage | undefined,
): number | undefined {
    const provider = useWorkbenchStore((state) => {
        const terminal = state.bootstrap?.terminals.find(({ id }) => id === terminalId);
        const session = state.bootstrap?.sessions.find(({ id }) => id === terminal?.sessionId);
        return terminal?.lastProcessState === 'running' &&
            session?.primaryAgentTerminalId === terminalId
            ? terminal.provider
            : undefined;
    });
    const isEnabled = useWorkbenchStore(
        (state) =>
            (state.bootstrap?.settings ?? defaultAppSettings)['agentChat.idleCompaction.enabled'],
    );
    return isEnabled ? agentChatIdleCompactionAt(usage, provider) : undefined;
}

/**
 * Both of the row's actions share one Button shape, so neither reads as the lesser choice by styling alone.
 */
const ACTION_CLASS = 'min-h-6 shrink-0 gap-1.5 px-1.5 text-[12px]';

/**
 * One notice of the row: its glyph, then its short text as a Tab stop whose tooltip carries the numbers.
 */
function ContextNotice({
    alert,
    cacheState,
    className,
    icon: Icon,
}: {
    alert: { detail: string; text: string };
    /**
     * Marks the cache notice with its state for tests; omitted for the context-pressure notice.
     */
    cacheState?: 'compacting' | 'expired' | 'expiring';
    className: string;
    icon: LucideIcon;
}) {
    return (
        <span
            className={cn('flex min-w-0 items-center gap-2', className)}
            data-agent-chat-cache-alert={cacheState}
        >
            <Icon aria-hidden className="size-3.5 shrink-0" />
            <Tooltip content={alert.detail}>
                <span
                    className="truncate rounded-md focus-visible:outline focus-visible:outline-accent"
                    tabIndex={0}
                >
                    {alert.text}
                </span>
            </Tooltip>
        </span>
    );
}

/**
 * The row's trailing actions: continue in a new Chat once the cache expired (a spinner replaces its glyph while the new
 * Chat opens), Compact while the context is high and the provider reports a compact command (`onCompact` is omitted
 * otherwise), and a dismiss button while a cache notice shows (`onDismissCache`).
 */
function ContextActions({
    isCompacting,
    isContinuing,
    isExpired,
    onCompact,
    onContinueInNewChat,
    onDismissCache,
}: {
    /**
     * True while idle compaction is counting down: the button then reads "Compact now", since the user would otherwise
     * wait for the same compaction.
     */
    isCompacting: boolean;
    isContinuing: boolean;
    isExpired: boolean;
    onCompact: (() => void) | undefined;
    onContinueInNewChat: () => void;
    onDismissCache: (() => void) | undefined;
}) {
    const { t } = useTranslation();
    return (
        <span className="-mr-1.5 ml-auto flex shrink-0 items-center gap-1">
            {isExpired && (
                <Tooltip content={t('agentChat.context.continueTooltip')}>
                    <Button
                        aria-disabled={isContinuing || undefined}
                        className={ACTION_CLASS}
                        size="sm"
                        variant="secondary"
                        onClick={onContinueInNewChat}
                    >
                        {isContinuing ? (
                            <Spinner className="size-3.5" role="presentation" />
                        ) : (
                            <MessageSquarePlus aria-hidden className="size-3.5" />
                        )}
                        {t('agentChat.context.continueInNewChat')}
                    </Button>
                </Tooltip>
            )}
            {onCompact && (
                <Button className={ACTION_CLASS} size="sm" variant="secondary" onClick={onCompact}>
                    {t(isCompacting ? 'agentChat.context.compactNow' : 'agentChat.context.compact')}
                </Button>
            )}
            {onDismissCache && (
                <Tooltip content={t('agentChat.context.dismissCache')}>
                    <Button
                        aria-label={t('agentChat.context.dismissCache')}
                        className="size-6 rounded-md text-muted enabled:hover:text-foreground"
                        size="icon"
                        variant="ghost"
                        onClick={onDismissCache}
                    >
                        <X aria-hidden className="size-3.5" />
                    </Button>
                </Tooltip>
            )}
        </span>
    );
}

/**
 * The composer's first row while an idle Chat's context needs attention: the prompt cache is about to expire
 * (`--warning`: still avoidable by replying now), the cache expired, so the next reply re-reads the whole conversation
 * (`--muted`: a cost fact, not a fault), or the context is high enough to compact first (`--warning`: a suggestion,
 * since nothing failed, with a Compact button when the provider reports a compact command, also offered as "Compact
 * now" while idle compaction counts down). It takes the activity bar's place and shape, so it is hidden while a turn
 * runs, when neither notice is actionable. Expiry is judged on a minute clock, which runs while the composer is mounted
 * so the live region below can follow the state. An expired cache also offers to continue in a new Chat, which reads
 * the old transcript through a cheap subagent instead of rewriting it. A cache notice shows only when the rewrite is
 * worth mentioning (`isAgentChatCacheRewriteNoticeable`), and its dismiss button hides it for this Chat until the next
 * reply restarts the cache.
 *
 * The row itself is not a live region, because its countdown and idle time change every minute; a separate polite
 * region stays mounted and announces only a change of state (`agentChatContextAnnouncement`). Each notice's text is a
 * Tab stop so a keyboard user can open the tooltip with its numbers.
 */
export function AgentChatContextAlerts({
    isContinuing,
    isShown,
    onCompact,
    onContinueInNewChat,
    terminalId,
    usage,
}: {
    /**
     * True while the new Chat is being opened; the button dims and the handler ignores further clicks.
     */
    isContinuing: boolean;
    /**
     * Whether the strip has room for the row: no activity row and no "Edit from here" bar. The live region stays
     * mounted either way, so a notice appearing is announced.
     */
    isShown: boolean;
    /**
     * Runs the provider's compact command; omitted when the provider reports none.
     */
    onCompact: (() => void) | undefined;
    onContinueInNewChat: () => void;
    terminalId: string;
    usage: AgentChatUsage | undefined;
}) {
    // The alert text comes from the global `translate`; subscribing here re-renders it when the language changes.
    useTranslation();
    const dismissedResponseAt = useAgentChatCacheNoticeDismissals(
        (state) => state.dismissedResponseAt[terminalId],
    );
    const now = useClockTick('minute');
    const idleCompactionAt = useAgentChatIdleCompactionAt(terminalId, usage);
    const lastResponseAt = usage?.lastResponseAt;
    const alerts = agentChatUndismissedContextAlerts(
        agentChatContextAlerts(usage, now, idleCompactionAt),
        lastResponseAt,
        dismissedResponseAt,
    );
    const { canCompact, isCompacting, isExpired, isVisible } = agentChatContextRowState(
        alerts,
        isShown,
        onCompact !== undefined,
    );
    return (
        <>
            <span aria-live="polite" className="sr-only" role="status">
                {isVisible ? agentChatContextAnnouncement(alerts) : undefined}
            </span>
            {isVisible && (
                <div
                    className="flex h-8 min-w-0 items-center gap-3 border-0 border-b border-solid border-border px-3 text-[12px]"
                    data-agent-chat-composer-strip-row=""
                >
                    {alerts.cache && (
                        <ContextNotice
                            alert={alerts.cache}
                            cacheState={alerts.cache.state}
                            className={isExpired ? 'text-muted' : 'text-warning'}
                            icon={isExpired ? TimerOff : Timer}
                        />
                    )}
                    {alerts.cache && alerts.pressure && (
                        <span aria-hidden className="h-3 w-px shrink-0 bg-border" />
                    )}
                    {alerts.pressure && (
                        <ContextNotice
                            alert={alerts.pressure}
                            className="text-warning"
                            icon={Gauge}
                        />
                    )}
                    <ContextActions
                        isCompacting={isCompacting}
                        isContinuing={isContinuing}
                        isExpired={isExpired}
                        onCompact={canCompact ? onCompact : undefined}
                        onContinueInNewChat={onContinueInNewChat}
                        onDismissCache={
                            lastResponseAt !== undefined && alerts.cache
                                ? () => dismissAgentChatCacheNotice(terminalId, lastResponseAt)
                                : undefined
                        }
                    />
                </div>
            )}
        </>
    );
}
