import { useMemo } from 'react';

import { parseMarkdownBlocks } from '@caxri/markdown';
import type { CommanderInboxItem } from '@caxri/protocol';
import { commanderInboxKindLabel, commanderInboxReplyState } from '@caxri/protocol';
import { relativeTime } from '@caxri/utils';
import { ExternalLink, GitMerge, MessageSquareReply, SquareArrowOutUpRight } from 'lucide-react';

import { MarkdownBlocks } from '../../components/markdown/markdown-blocks';
import { Button } from '../../components/ui/button';
import { Spinner } from '../../components/ui/spinner';
import { Tooltip } from '../../components/ui/tooltip';
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
    const blocks = useMemo(() => parseMarkdownBlocks(item.body), [item.body]);
    const replyState = commanderInboxReplyState(item);
    return (
        <li
            className={cn(
                'commander-inbox-item flex flex-col gap-1.5 rounded-md border border-border p-2',
                /*
                 * The reply target is a persistent selection, not focus, so it takes the raised `--elevated` fill
                 * instead of the accent DESIGN.md reserves for the one focus indicator.
                 */
                isTarget ? 'bg-elevated' : 'bg-background',
            )}
            data-inbox-target={isTarget || undefined}
            data-inbox-kind={item.kind}
            data-inbox-item-id={item.id}
        >
            <div className="flex min-w-0 items-baseline gap-1.5">
                <span className="min-w-0 flex-1 text-[13px] leading-5 font-medium wrap-anywhere">
                    {item.title}
                </span>
                <span className="flex-none text-[11px] text-muted">
                    {relativeTime(item.updatedAt, now, 'narrow')}
                </span>
            </div>
            <div className="flex min-w-0 items-center gap-1 text-[11px] text-muted">
                <span>{commanderInboxKindLabel(item.kind)}</span>
                {item.pullRequest && (
                    <>
                        <span aria-hidden="true">·</span>
                        <Tooltip content="Open the pull request in the browser">
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
                        <Tooltip content="Show this Session in the Workbench">
                            <button
                                type="button"
                                className="flex cursor-pointer items-center gap-0.5 hover:text-foreground"
                                onClick={() => revealCommanderSession(item.sessionId!)}
                            >
                                Session
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
    const isAnswering = useCommanderInboxUiStore(
        (state) => state.pendingActions[item.id] === 'answer',
    );
    return (
        <div
            aria-busy={isAnswering}
            aria-label="Answers"
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
                        // eslint-disable-next-line no-void -- intentional floating-promise discard, see above
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
    const merge = item.kind === 'merge' ? commanderInboxMergeState(item) : undefined;
    const isMerging = useCommanderInboxUiStore(
        (state) => state.pendingActions[item.id] === 'merge',
    );
    return (
        <div className="commander-inbox-actions flex flex-wrap items-center gap-1">
            {merge && (
                <Tooltip
                    content={
                        isMerging
                            ? 'Merging…'
                            : (merge.reason ?? 'Merge the commit the Commander verified')
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
                                // eslint-disable-next-line no-void -- intentional floating-promise discard, see above
                                void mergeCommanderInboxItem(item);
                            }}
                        >
                            {isMerging ? (
                                <Spinner aria-hidden="true" className="size-[13px]" />
                            ) : (
                                <GitMerge size={13} />
                            )}
                            {isMerging ? 'Merging…' : 'Merge'}
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
                Reply
            </Button>
            <Button
                size="sm"
                variant="ghost"
                className="commander-inbox-dismiss text-muted"
                onClick={() => {
                    // Fire-and-forget: the dismiss command reports its own failure through a toast.
                    // eslint-disable-next-line no-void -- intentional floating-promise discard, see above
                    void dismissCommanderInboxItem(item);
                }}
            >
                Dismiss
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
