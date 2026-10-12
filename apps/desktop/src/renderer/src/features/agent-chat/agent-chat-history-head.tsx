import type { ReactNode, RefObject } from 'react';
import { useEffect, useRef } from 'react';

import { AGENT_CHAT_HISTORY_HEAD_ATTRIBUTE } from './agent-chat-history';

/**
 * How far above the view the next page starts loading, so a reader scrolling back at a steady pace rarely reaches the
 * top before it arrives.
 */
const PRELOAD_MARGIN_PX = 1600;

/**
 * The top of a Chat transcript whose conversation goes back further than the pane holds: it loads the previous page
 * once the reader scrolls near it, says so while a page is on its way or failed, and says when the rest cannot be shown
 * in Chat at all.
 */
export function AgentChatHistoryHead({
    hasFailed,
    hasMore,
    isLoading,
    isUnavailable,
    loadedCount,
    onLoad,
    onOpenAsTerminal,
    providerName,
    scrollReference,
}: {
    hasFailed: boolean;
    hasMore: boolean;
    isLoading: boolean;
    /**
     * Older history exists that Chat cannot show.
     */
    isUnavailable: boolean;
    /**
     * Items read back so far. Observing again after each page loads the next one when the reader is still near the top,
     * which a lasting intersection would not report a second time.
     */
    loadedCount: number;
    onLoad: () => void;
    onOpenAsTerminal: (() => void) | undefined;
    providerName: string;
    scrollReference: RefObject<HTMLDivElement | null>;
}): ReactNode {
    const sentinelReference = useRef<HTMLDivElement | null>(null);
    const canLoad = hasMore && !isLoading && !hasFailed;
    useEffect(() => {
        const sentinel = sentinelReference.current;
        const root = scrollReference.current;
        if (!canLoad || !sentinel || !root) return;
        const observer = new IntersectionObserver(
            (entries) => {
                if (entries.some((entry) => entry.isIntersecting)) onLoad();
            },
            { root, rootMargin: `${PRELOAD_MARGIN_PX}px 0px 0px 0px` },
        );
        observer.observe(sentinel);
        return () => observer.disconnect();
    }, [canLoad, loadedCount, onLoad, scrollReference]);
    if (hasMore)
        return (
            <div
                {...{ [AGENT_CHAT_HISTORY_HEAD_ATTRIBUTE]: '' }}
                className="flex min-h-4 justify-center"
                ref={sentinelReference}
            >
                {hasFailed ? (
                    <p className="m-0 text-[11px] text-muted" role="status">
                        Earlier messages could not be loaded.{' '}
                        <button
                            className="cursor-pointer border-0 bg-transparent p-0 text-foreground hover:underline focus-visible:outline focus-visible:outline-accent"
                            type="button"
                            onClick={onLoad}
                        >
                            Retry
                        </button>
                    </p>
                ) : (
                    isLoading && (
                        <p className="m-0 text-[11px] text-muted" role="status">
                            Loading earlier messages…
                        </p>
                    )
                )}
            </div>
        );
    if (!isUnavailable) return null;
    return (
        <p
            {...{ [AGENT_CHAT_HISTORY_HEAD_ATTRIBUTE]: '' }}
            className="m-0 text-center text-[11px] text-muted"
        >
            Earlier messages are not available in Chat. {providerName} still has all of them.
            {onOpenAsTerminal && (
                <>
                    {' '}
                    <button
                        className="cursor-pointer border-0 bg-transparent p-0 text-foreground hover:underline focus-visible:outline focus-visible:outline-accent"
                        type="button"
                        onClick={onOpenAsTerminal}
                    >
                        Open as Terminal
                    </button>
                </>
            )}
        </p>
    );
}
