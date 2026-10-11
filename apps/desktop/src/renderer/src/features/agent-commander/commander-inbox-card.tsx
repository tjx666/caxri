import { useMemo } from 'react';

import { parseMarkdownBlocks } from '@caxri/markdown';
import type { CommanderInboxItem } from '@caxri/protocol';
import { relativeTime } from '@caxri/utils';
import { ExternalLink, GitMerge, MessageSquareReply, SquareArrowOutUpRight } from 'lucide-react';

import { MarkdownBlocks } from '../../components/markdown/markdown-blocks';
import { Button } from '../../components/ui/button';
import { Tooltip } from '../../components/ui/tooltip';
import { cn } from '../../lib/utilities';
import { openCommanderPullRequest, revealCommanderSession } from './commander-commands';
import {
    commanderInboxKindLabel,
    commanderInboxMergeState,
    commanderInboxReplyState,
} from './commander-inbox';
import { dismissCommanderInboxItem, mergeCommanderInboxItem } from './commander-inbox-commands';
import { chooseCommanderInboxReplyTarget } from './commander-inbox-store';

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
                'commander-inbox-item flex flex-col gap-1.5 rounded-md border border-border bg-background p-2',
                isTarget && 'border-accent',
            )}
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
            {item.options.length > 0 && (
                <ol className="commander-inbox-options flex list-decimal flex-col gap-0.5 pl-5 text-[12px]">
                    {item.options.map((option) => (
                        <li key={option}>{option}</li>
                    ))}
                </ol>
            )}
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

function CommanderInboxActions({ item }: { item: CommanderInboxItem }) {
    const merge = item.kind === 'merge' ? commanderInboxMergeState(item) : undefined;
    return (
        <div className="commander-inbox-actions flex flex-wrap items-center gap-1">
            {merge && (
                <Tooltip content={merge.reason ?? 'Merge the commit the Commander verified'}>
                    <span>
                        <Button
                            size="sm"
                            variant="default"
                            className="commander-inbox-merge"
                            disabled={!merge.canMerge}
                            onClick={() => {
                                // Fire-and-forget: the merge command reports its own failure through a toast.
                                // eslint-disable-next-line no-void -- intentional floating-promise discard, see above
                                void mergeCommanderInboxItem(item);
                            }}
                        >
                            <GitMerge size={13} />
                            Merge
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
