import type { ReactElement } from 'react';

import type { SourceControlHistoryDescriptor, SourceControlHistoryPage } from '@caxri/protocol';
import { relativeTime } from '@caxri/utils';

import { HoverCard, HoverCardContent, HoverCardTrigger } from '../../../components/ui/hover-card';
import { SourceControlHistoryAvatar } from './source-control-history-avatar';
import { SourceControlHistoryHoverDetails } from './source-control-history-details';

type SourceControlHistoryItem = SourceControlHistoryPage['items'][number];

export function SourceControlHistoryHoverCard({
    descriptor,
    item,
    now,
    path,
    trigger,
}: {
    descriptor: SourceControlHistoryDescriptor;
    item: SourceControlHistoryItem;
    now: number;
    path?: string;
    trigger: ReactElement<Record<string, unknown>>;
}) {
    return (
        <HoverCard>
            <HoverCardTrigger closeDelay={80} delay={500} render={trigger} />
            <HoverCardContent
                align="start"
                className="commit-hover-card w-80 max-w-[calc(100vw-16px)] p-3"
                collisionAvoidance={{ align: 'shift', fallbackAxisSide: 'end', side: 'flip' }}
                collisionBoundary={document.documentElement}
                collisionPadding={8}
                positionMethod="fixed"
                role="tooltip"
                side="left"
            >
                <div className="flex items-center gap-2.5">
                    <SourceControlHistoryAvatar item={item} size={30} />
                    <div className="min-w-0">
                        <div className="truncate text-[12px] font-semibold text-foreground">
                            {item.author}
                        </div>
                        <div
                            className="truncate text-[11px] text-muted"
                            title={item.tooltipTimestamp}
                        >
                            {relativeTime(item.timestamp, now)} · {item.tooltipTimestamp}
                        </div>
                    </div>
                </div>
                <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[11px]">
                    <code className="rounded bg-elevated px-1 py-0.5 text-muted">
                        {item.description}
                    </code>
                    <SourceControlHistoryHoverDetails
                        descriptor={descriptor}
                        itemId={item.id}
                        path={path}
                    />
                </div>
                {item.decorations.length > 0 && (
                    <div className="mt-1.5 flex max-w-full flex-wrap gap-1">
                        {item.decorations.map((decoration) => (
                            <span
                                className="max-w-full truncate rounded bg-elevated px-1 text-[10px] text-muted"
                                key={decoration}
                            >
                                {decoration}
                            </span>
                        ))}
                    </div>
                )}
                <div className="mt-2 border-t border-border pt-2 text-[12px] leading-relaxed text-foreground">
                    <div className="break-words">{item.label}</div>
                    {item.body && (
                        <div className="mt-1.5 max-h-48 overflow-y-auto text-[11px] leading-relaxed break-words whitespace-pre-line text-muted">
                            {item.body}
                        </div>
                    )}
                </div>
            </HoverCardContent>
        </HoverCard>
    );
}
