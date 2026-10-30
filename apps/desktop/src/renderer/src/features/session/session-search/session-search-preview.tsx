import { useEffect, useRef } from 'react';

import type { SessionSearchEntry } from '@caxri/protocol';
import { snippetSegments } from '@caxri/protocol';
import { ChevronDown, ChevronUp } from 'lucide-react';

import { LoadingSkeleton } from '../../../components/loading-skeleton';
import { Tooltip } from '../../../components/ui/tooltip';
import type { Translate } from '../../../i18n';
import { useTranslation } from '../../../i18n';
import { resolveAgentIcon } from '../../../icons/agents/agent-icon-registry';
import { cn } from '../../../lib/utilities';
import { sessionTitleForDisplay } from '../session-title';
import type { SessionSearchPreviewModel } from './use-session-search-preview';

function speakerLabel(role: 'assistant' | 'user', entry: SessionSearchEntry, t: Translate): string {
    return role === 'user'
        ? t('session.search.speaker.user')
        : resolveAgentIcon(entry.provider).label;
}

function MatchStepButton({
    direction,
    label,
    onClick,
}: {
    direction: 'next' | 'previous';
    label: string;
    onClick: () => void;
}) {
    const Icon = direction === 'next' ? ChevronDown : ChevronUp;
    return (
        <Tooltip content={label}>
            <button
                aria-label={label}
                className="grid size-6 cursor-pointer place-items-center rounded border-0 bg-transparent p-0 text-muted hover:bg-elevated hover:text-foreground"
                type="button"
                // Keep focus in the search input so arrow keys keep moving the result selection.
                onMouseDown={(event) => event.preventDefault()}
                onClick={onClick}
            >
                <Icon size={14} />
            </button>
        </Tooltip>
    );
}

/**
 * The pane beside (or under) the result list: the selected conversation's matched message with two messages of context
 * each side, matched terms highlighted. It only reads, so it never changes what Enter does or where the conversation
 * lives.
 */
export function SessionSearchPreview({
    entry,
    hasQuery,
    preview,
}: {
    entry: SessionSearchEntry;
    hasQuery: boolean;
    preview: SessionSearchPreviewModel;
}) {
    const { t } = useTranslation();
    const { data } = preview;
    const matchReference = useRef<HTMLDivElement>(null);
    useEffect(() => {
        matchReference.current?.scrollIntoView({ block: 'nearest' });
    }, [data]);
    const matchCount = data?.matchCount ?? 0;
    return (
        <section
            aria-label={t('session.search.preview.label')}
            className="flex min-h-0 flex-1 flex-col"
            data-session-search-preview={entry.key}
        >
            <div className="flex h-8 flex-none items-center gap-2 border-b border-border pr-2 pl-3">
                <span className="min-w-0 flex-1 truncate text-[12px] font-medium">
                    {entry.status === 'external'
                        ? entry.title || t('session.search.untitledConversation')
                        : sessionTitleForDisplay(entry.title, t)}
                </span>
                {matchCount > 0 ? (
                    <>
                        <span
                            className="flex-none text-[11px] text-muted tabular-nums"
                            data-session-search-preview-position
                        >
                            {t('session.search.preview.match', {
                                current: (data?.matchIndex ?? 0) + 1,
                                total: matchCount,
                            })}
                        </span>
                        <span className="flex flex-none">
                            <MatchStepButton
                                direction="previous"
                                label={t('session.search.preview.prevMatch')}
                                onClick={() => preview.stepMatch(-1)}
                            />
                            <MatchStepButton
                                direction="next"
                                label={t('session.search.preview.nextMatch')}
                                onClick={() => preview.stepMatch(1)}
                            />
                        </span>
                    </>
                ) : (
                    data &&
                    data.messages.length > 0 && (
                        <span className="flex-none text-[11px] text-muted">
                            {t(
                                hasQuery
                                    ? 'session.search.preview.noMatch'
                                    : 'session.search.preview.latest',
                            )}
                        </span>
                    )
                )}
            </div>
            {entry.status === 'external' && (
                <div className="flex-none border-b border-border bg-elevated px-3 py-1 text-[11px] text-muted">
                    {t('session.search.preview.external')}
                </div>
            )}
            <div
                className={cn(
                    'min-h-0 flex-1 overflow-y-auto py-1',
                    preview.isStale && 'opacity-60',
                )}
            >
                <PreviewBody entry={entry} matchRef={matchReference} preview={preview} />
            </div>
        </section>
    );
}

function PreviewNotice({ children }: { children: string }) {
    return <div className="p-4 text-center text-[12px] text-muted">{children}</div>;
}

function PreviewBody({
    entry,
    matchRef,
    preview,
}: {
    entry: SessionSearchEntry;
    matchRef: React.RefObject<HTMLDivElement | null>;
    preview: SessionSearchPreviewModel;
}) {
    const { t } = useTranslation();
    const { data } = preview;
    if (!preview.hasConversation)
        return <PreviewNotice>{t('session.search.preview.empty')}</PreviewNotice>;
    if (preview.isError) return <PreviewNotice>{t('session.search.preview.failed')}</PreviewNotice>;
    if (!data)
        return (
            <div className="p-2">
                <LoadingSkeleton
                    variant="list"
                    rows={4}
                    label={t('session.search.preview.loading')}
                />
            </div>
        );
    if (data.messages.length === 0)
        return <PreviewNotice>{t('session.search.preview.empty')}</PreviewNotice>;
    return (
        <>
            {data.hasEarlier && (
                <div className="px-3 py-1 text-[11px] text-muted">
                    ⋯ {t('session.search.preview.earlier')}
                </div>
            )}
            {data.messages.map((message, index) => (
                <div
                    key={index}
                    ref={message.isMatch ? matchRef : undefined}
                    className={cn(
                        'mx-1 grid gap-0.5 rounded px-2 py-1.5',
                        message.isMatch && 'bg-elevated',
                    )}
                    data-session-search-preview-match={message.isMatch || undefined}
                >
                    <span className="text-[11px] font-medium text-muted">
                        {speakerLabel(message.role, entry, t)}
                    </span>
                    <span
                        className={cn(
                            'text-[12px] break-words whitespace-pre-wrap',
                            message.isMatch ? 'text-foreground' : 'text-muted',
                        )}
                    >
                        {snippetSegments(message).map((segment, segmentIndex) =>
                            segment.isMatch ? (
                                <mark
                                    key={segmentIndex}
                                    className="bg-transparent font-semibold text-foreground underline decoration-accent decoration-2 underline-offset-2"
                                >
                                    {segment.text}
                                </mark>
                            ) : (
                                <span key={segmentIndex}>{segment.text}</span>
                            ),
                        )}
                    </span>
                </div>
            ))}
            {data.hasLater && (
                <div className="px-3 py-1 text-[11px] text-muted">
                    ⋯ {t('session.search.preview.later')}
                </div>
            )}
        </>
    );
}
