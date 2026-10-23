import { useMemo } from 'react';

import { parseMarkdownBlocks } from '@caxri/markdown';
import type { CommanderInboxItem } from '@caxri/protocol';
import { commanderInboxKindLabel, commanderInboxReplyState } from '@caxri/protocol';
import { ExternalLink, GitMerge, MessageSquareReply, SquareArrowOutUpRight } from 'lucide-react';

import { MarkdownBlocks } from '../../components/markdown/markdown-blocks';
import { Button } from '../../components/ui/button';
import { Spinner } from '../../components/ui/spinner';
import { Tooltip } from '../../components/ui/tooltip';
import { useTranslation } from '../../i18n';
import { localizedRelativeTime } from '../../lib/relative-time';
import { cn } from '../../lib/utilities';
import { openCommanderPullRequest, revealCommanderSession } from './commander-commands';
import { commanderInboxMergeState } from './commander-inbox';
import {
    answerCommanderInboxItem,
    dismissCommanderInboxItem,
    mergeCommanderInboxItem,
} from './commander-inbox-commands';
import { chooseCommanderInboxReplyTarget, useCommanderInboxUiStore } from './commander-inbox-store';

const TONE_CLASS_NAMES = {
    danger: 'text-danger',
    muted: 'text-muted',
    success: 'text-success',
    warning: 'text-warning',
} as const;

/**
 * One Inbox card: the Commander's question or report, the owner's replies, and the actions the owner owns.
 */
export function CommanderInboxCard({
    isTarget,
    item,
    now,
}: {
    isTarget: boolean;
    item: CommanderInboxItem;
    now: number;
}) {
    const { locale, t } = useTranslation();
    const blocks = useMemo(() => parseMarkdownBlocks(item.body), [item.body]);
    const replyState = commanderInboxReplyState(item, t);
    return (
        <li
            className={cn(
                'commander-inbox-item flex flex-col gap-1.5 rounded-md border border-border p-2 outline-none',
                /*
                 * A 2px inset accent outline, not just the 1px border recolor: the `N need you` chip lands focus here
                 * from another window, so it must read at a glance. Drawn inside the border box so the scrolling list
                 * never clips it, and gated on `:focus-visible` so a pointer click shows no ring.
                 */
                'focus-visible:outline-2 focus-visible:-outline-offset-1 focus-visible:outline-accent focus-visible:outline-solid',
                /*
                 * The reply target is a persistent selection, not focus, so it takes the raised `--elevated` fill
                 * instead of the accent DESIGN.md reserves for the one focus indicator.
                 */
                isTarget ? 'bg-elevated' : 'bg-background',
            )}
            data-inbox-target={isTarget || undefined}
            data-inbox-kind={item.kind}
            data-inbox-item-id={item.id}
            // Focusable only from script: the status bar's `N need you` chip lands the keyboard on the first open item.
            tabIndex={-1}
        >
            <div className="flex min-w-0 items-baseline gap-1.5">
                <span className="min-w-0 flex-1 text-[13px] leading-5 font-medium wrap-anywhere">
                    {item.title}
                </span>
                <span className="flex-none text-[11px] text-muted">
                    {localizedRelativeTime(item.updatedAt, now, 'narrow', locale)}
                </span>
            </div>
            <div className="flex min-w-0 items-center gap-1 text-[11px] text-muted">
                <span>{commanderInboxKindLabel(item.kind, t)}</span>
                {item.pullRequest && (
                    <>
                        <span aria-hidden="true">·</span>
                        <Tooltip content={t('agentCommander.inbox.openPullRequest')}>
                            <button
                                type="button"
                                className="flex min-w-0 cursor-pointer items-center gap-0.5 truncate hover:text-foreground"
                                onClick={() => openCommanderPullRequest(item.pullRequest!.url)}
                            >
                                {item.pullRequest.repo}#{item.pullRequest.number}
                                <ExternalLink size={10} />
                            </button>
                        </Tooltip>
                    </>
                )}
                {item.sessionId && (
                    <>
                        <span aria-hidden="true">·</span>
                        <Tooltip content={t('agentCommander.inbox.showSession')}>
                            <button
                                type="button"
                                className="flex cursor-pointer items-center gap-0.5 hover:text-foreground"
                                onClick={() => revealCommanderSession(item.sessionId!)}
                            >
                                {t('agentCommander.inbox.session')}
                                <SquareArrowOutUpRight size={10} />
                            </button>
                        </Tooltip>
                    </>
                )}
            </div>
            {blocks.length > 0 && (
                <div className="commander-inbox-body flex max-h-72 flex-col gap-1.5 overflow-y-auto text-[12px] leading-5 wrap-anywhere">
                    <MarkdownBlocks blocks={blocks} onOpenUrl={openCommanderPullRequest} />
                </div>
            )}
            {item.options.length > 0 && <CommanderInboxOptions item={item} />}
            {item.replies.length > 0 && (
                <ul className="commander-inbox-replies flex flex-col gap-1 border-l-2 border-border pl-2">
                    {item.replies.map((reply) => (
                        <li
                            key={reply.sequence}
                            className="text-[12px] leading-5 wrap-anywhere whitespace-pre-wrap"
                        >
                            {reply.body}
                        </li>
                    ))}
                    {replyState && (
                        <li
                            className={cn(
                                'commander-inbox-reply-state text-[11px]',
                                replyState.isRead ? 'text-success' : 'text-muted',
                            )}
                        >
                            {replyState.label}
                        </li>
                    )}
                </ul>
            )}
            <CommanderInboxActions item={item} />
        </li>
    );
}

/**
 * The answers the Commander offered, each a button that sends it as the reply. The composer below stays the way to
 * answer anything else.
 */
function CommanderInboxOptions({ item }: { item: CommanderInboxItem }) {
    const { t } = useTranslation();
    const isAnswering = useCommanderInboxUiStore(
        (state) => state.pendingActions[item.id] === 'answer',
    );
    return (
        <div
            aria-busy={isAnswering}
            aria-label={t('agentCommander.inbox.answers')}
            className="commander-inbox-options flex flex-wrap gap-1"
            role="group"
        >
            {item.options.map((option) => (
                <Button
                    key={option}
                    className="commander-inbox-option h-auto min-h-6 max-w-full py-0.5 text-left whitespace-normal"
                    disabled={isAnswering}
                    size="sm"
                    variant="secondary"
                    onClick={() => {
                        // Fire-and-forget: the reply command reports its own failure through a toast.
                        void answerCommanderInboxItem(item, option);
                    }}
                >
                    {option}
                </Button>
            ))}
        </div>
    );
}

function CommanderInboxActions({ item }: { item: CommanderInboxItem }) {
    const { t } = useTranslation();
    const merge = item.kind === 'merge' ? commanderInboxMergeState(item, t) : undefined;
    const isMerging = useCommanderInboxUiStore(
        (state) => state.pendingActions[item.id] === 'merge',
    );
    return (
        <div className="commander-inbox-actions flex flex-wrap items-center gap-1">
            {merge && (
                <Tooltip
                    content={
                        isMerging
                            ? t('agentCommander.inbox.merging')
                            : (merge.reason ?? t('agentCommander.inbox.mergeTooltip'))
                    }
                >
                    <span>
                        <Button
                            aria-busy={isMerging}
                            size="sm"
                            variant="default"
                            className="commander-inbox-merge"
                            disabled={!merge.canMerge || isMerging}
                            onClick={() => {
                                // Fire-and-forget: the merge command reports its own failure through a toast.
                                void mergeCommanderInboxItem(item);
                            }}
                        >
                            {isMerging ? (
                                <Spinner aria-hidden="true" className="size-[13px]" />
                            ) : (
                                <GitMerge size={13} />
                            )}
                            {t(
                                isMerging
                                    ? 'agentCommander.inbox.merging'
                                    : 'agentCommander.inbox.merge',
                            )}
                        </Button>
                    </span>
                </Tooltip>
            )}
            <Button
                size="sm"
                variant="ghost"
                className="commander-inbox-reply"
                onClick={() => chooseCommanderInboxReplyTarget(item.id)}
            >
                <MessageSquareReply size={13} />
                {t('agentCommander.inbox.reply')}
            </Button>
            <Button
                size="sm"
                variant="ghost"
                className="commander-inbox-dismiss text-muted"
                onClick={() => dismissCommanderInboxItem(item)}
            >
                {t('common.dismiss')}
            </Button>
            {merge?.label && (
                <span
                    className={cn('ml-auto text-[11px]', TONE_CLASS_NAMES[merge.tone ?? 'muted'])}
                >
                    {merge.label}
                </span>
            )}
        </div>
    );
}
