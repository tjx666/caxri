import type { AgentChatContextReport } from '@caxri/protocol';
import { CircleAlert, Layers, RefreshCw } from 'lucide-react';

import { useClockTick } from '@/hooks/use-clock-tick';

import { LoadingSkeleton } from '../../../components/loading-skeleton';
import { Button } from '../../../components/ui/button';
import { Empty, EmptyMedia, EmptyTitle } from '../../../components/ui/empty';
import { Tooltip } from '../../../components/ui/tooltip';
import { useTranslation } from '../../../i18n';
import { AgentIdentityIcon } from '../../../icons/agents/agent-identity-icon';
import { localizedRelativeTime } from '../../../lib/relative-time';
import { cn } from '../../../lib/utilities';
import { useTerminal } from '../../../stores/selectors';
import { analyzeContextCache } from './cache-analysis';
import { contextWindowSegments } from './composition';
import { ContextCacheCard } from './context-cache-card';
import { ContextDetailCards } from './context-detail-cards';
import { ContextSuggestionsCard } from './context-suggestions-card';
import { ContextTiles } from './context-tiles';
import { ContextWindowCard } from './context-window-card';
import { contextSuggestions } from './suggestions';
import { useAgentContextReport } from './use-agent-context-report';

/**
 * Claude Code's default prompt-cache lifetime, assumed until a request reports its own.
 */
const DEFAULT_CACHE_TTL_MINUTES = 5;

/**
 * Context tab for one Agent Chat, opened from the composer meter's card: what fills the context window item by item
 * (MCP servers and tools, skills, memory files, custom agents, the conversation by tool), and how the prompt cache
 * served every request, with each break, its likely cause, and what the rewrite cost. Claude Code only: its SDK
 * describes the window and its transcript records every request's cache usage. See `docs/agent-chat.md`.
 */
export function AgentContextPage({ terminalId }: { terminalId: string }) {
    const { t } = useTranslation();
    const terminal = useTerminal(terminalId);
    if (terminal && terminal.kind !== 'claude')
        return (
            <Empty className="h-full">
                <EmptyMedia>
                    <Layers aria-hidden="true" size={24} />
                </EmptyMedia>
                <EmptyTitle>{t('agentChat.contextPage.unsupported')}</EmptyTitle>
            </Empty>
        );
    return <ContextReportView terminalId={terminalId} />;
}

function ContextReportView({ terminalId }: { terminalId: string }) {
    const { t } = useTranslation();
    const terminal = useTerminal(terminalId);
    const now = useClockTick('minute');
    const { chat, report } = useAgentContextReport(terminalId);
    const data: AgentChatContextReport | undefined = report.data;
    const usage = chat.data?.usage;
    const composition = data?.composition;
    const analysis = analyzeContextCache(
        data?.requests ?? [],
        data?.changes ?? [],
        usage?.cacheTtlMinutes ?? DEFAULT_CACHE_TTL_MINUTES,
    );
    const model = composition?.model ?? data?.requests.at(-1)?.model;
    const refresh = () => {
        void report.refetch();
    };
    return (
        // `p-px` keeps the header's fill off the pane's 1px inset focus ring, as on the Usage tab.
        <div
            data-agent-context-page
            className="grid h-full grid-rows-[auto_minmax(0,1fr)] overflow-hidden p-px"
        >
            <ContextPageHeader
                generatedAt={data?.generatedAt}
                isFetching={report.isFetching}
                isRefreshFailed={report.isError && data !== undefined}
                model={model}
                terminalTitle={terminal?.title}
                onRefresh={refresh}
            />
            <div className="min-h-0 overflow-y-auto" aria-busy={report.isFetching}>
                {data ? (
                    <div className="mx-auto flex max-w-6xl flex-col gap-3 px-4 pb-4">
                        <ContextTiles analysis={analysis} composition={composition} usage={usage} />
                        {!composition && (
                            <p className="m-0 flex items-start gap-2 rounded-md border border-border bg-surface px-4 py-3 text-[12px] leading-[1.5] text-muted">
                                <CircleAlert
                                    aria-hidden="true"
                                    className="mt-0.5 shrink-0"
                                    size={14}
                                />
                                {t('agentChat.contextPage.noComposition')}
                            </p>
                        )}
                        <ContextSuggestionsCard
                            suggestions={contextSuggestions(t, composition, analysis)}
                        />
                        {composition && (
                            <ContextWindowCard
                                composition={composition}
                                lastRequest={data.requests.at(-1)}
                            />
                        )}
                        <ContextCacheCard
                            analysis={analysis}
                            isHistoryTruncated={data.isHistoryTruncated}
                            now={now}
                            segments={composition && contextWindowSegments(composition)}
                        />
                        {composition && <ContextDetailCards composition={composition} />}
                    </div>
                ) : report.isError ? (
                    <Empty className="h-full">
                        <EmptyTitle className="text-danger">
                            {t('agentChat.contextPage.loadFailed')}
                        </EmptyTitle>
                        {/* The Server's own sentence says why (the Chat is gone, the provider has no report), so the
                            failure is not a dead end with only Retry to try. */}
                        {report.error.message && (
                            <p className="m-0 max-w-md text-center text-[12px] leading-[1.5] text-muted">
                                {report.error.message}
                            </p>
                        )}
                        <Button size="sm" variant="secondary" onClick={refresh}>
                            {t('common.retry')}
                        </Button>
                    </Empty>
                ) : (
                    <LoadingSkeleton variant="page" label={t('editor.load.loadingAgentContext')} />
                )}
            </div>
        </div>
    );
}

/**
 * Names the Chat the report describes and how fresh it is; a failed refresh keeps the last report and says so here.
 */
function ContextPageHeader({
    terminalTitle,
    model,
    generatedAt,
    isFetching,
    isRefreshFailed,
    onRefresh,
}: {
    terminalTitle: string | undefined;
    model: string | undefined;
    generatedAt: number | undefined;
    isFetching: boolean;
    isRefreshFailed: boolean;
    onRefresh: () => void;
}) {
    const { locale, t } = useTranslation();
    const now = useClockTick('minute');
    return (
        <div className="flex items-end justify-between gap-3 bg-surface pt-4 pr-4 pb-3 pl-4">
            <div className="flex min-w-0 items-center gap-2">
                <AgentIdentityIcon identity="claude" size={18} />
                <div className="min-w-0">
                    <h1 className="m-0 text-[15px] font-semibold">
                        {t('editor.tab.agentContext')}
                    </h1>
                    <p className="mt-0.5 mb-0 truncate text-[11px] text-muted">
                        {[
                            terminalTitle ?? t('agentChat.contextPage.terminalClosed'),
                            model,
                            generatedAt !== undefined &&
                                t('agentChat.contextPage.updated', {
                                    time: localizedRelativeTime(
                                        generatedAt,
                                        Math.max(now, generatedAt),
                                        'long',
                                        locale,
                                    ),
                                }),
                        ]
                            .filter(Boolean)
                            .join(' · ')}
                        {isRefreshFailed && (
                            <span className="text-danger">
                                {' · '}
                                {t('agentChat.contextPage.refreshFailed')}
                            </span>
                        )}
                    </p>
                </div>
            </div>
            <Tooltip content={t('agentChat.contextPage.refresh')}>
                <Button
                    aria-label={t('agentChat.contextPage.refresh')}
                    disabled={isFetching}
                    size="icon"
                    variant="ghost"
                    onClick={onRefresh}
                >
                    <RefreshCw
                        aria-hidden="true"
                        className={cn(isFetching && 'motion-safe:animate-spin')}
                        size={14}
                    />
                </Button>
            </Tooltip>
        </div>
    );
}
