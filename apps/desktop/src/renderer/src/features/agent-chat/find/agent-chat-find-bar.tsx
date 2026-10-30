import { History } from 'lucide-react';

import { FindBar } from '../../../components/find-bar';
import { Button } from '../../../components/ui/button';
import { useTranslation } from '../../../i18n';
import { agentChatFindCountLabel, canAgentChatFindSearchEarlier } from './agent-chat-find';

/**
 * The Chat's find bar, at the top right of the conversation like the Terminal's, clear of the message rail on the left
 * and Jump to latest at the bottom. It is docked in its own strip above the conversation (`AgentChatFindScope`) rather
 * than floating over it, so it never covers the transcript text it searches. Escape returns focus to the composer
 * through `onClose`. When nothing matches in the loaded messages and older history can still load, Search earlier
 * messages under the bar loads the next page; find repaints as it arrives and reveals the nearest earlier match.
 */
export function AgentChatFindBar({
    activeIndex,
    count,
    focusRevision,
    hasEarlierLoadFailed,
    isAutoLoading,
    isLoadingEarlier,
    isPartial,
    query,
    onClose,
    onNext,
    onPrevious,
    onQueryChange,
    onSearchEarlier,
}: {
    activeIndex: number;
    count: number;
    focusRevision: number;
    /**
     * The last page of older history failed to load, so an empty result may only be missing that page.
     */
    hasEarlierLoadFailed: boolean;
    /**
     * A Session search handoff is loading older pages on its own to look for a match.
     */
    isAutoLoading: boolean;
    isLoadingEarlier: boolean;
    /**
     * Older history exists that find has not searched, because it is not loaded or cannot be shown in Chat.
     */
    isPartial: boolean;
    query: string;
    onClose: () => void;
    onNext: () => void;
    onPrevious: () => void;
    onQueryChange: (query: string) => void;
    /**
     * Loads older history to search, or `undefined` when there is none to load.
     */
    onSearchEarlier?: () => void;
}) {
    const { t } = useTranslation();
    const canSearchEarlier = canAgentChatFindSearchEarlier(
        query,
        count,
        onSearchEarlier !== undefined,
    );
    const isEmpty = query !== '' && count === 0;
    const isSearching = isEmpty && (isLoadingEarlier || isAutoLoading);
    const hasLoadFailed = isEmpty && hasEarlierLoadFailed && !isSearching && canSearchEarlier;
    return (
        <>
            <FindBar
                ariaLabel={t('agentChat.find.label')}
                countLabel={agentChatFindCountLabel(query, count, activeIndex, t, {
                    isPartial,
                    isSearching,
                })}
                focusRevision={focusRevision}
                hasMatches={count > 0}
                inputLabel={t('agentChat.find.label')}
                isDocked
                isNoMatch={query !== '' && count === 0}
                query={query}
                onClose={onClose}
                onNext={onNext}
                onPrevious={onPrevious}
                onQueryChange={onQueryChange}
            />
            {hasLoadFailed && (
                <p
                    className="m-0 flex shrink-0 justify-end gap-1 px-2 pt-1 text-[12px] text-muted"
                    role="status"
                >
                    {t('agentChat.find.loadFailed')}
                    <button
                        className="cursor-pointer border-0 bg-transparent p-0 text-foreground hover:underline focus-visible:outline focus-visible:outline-accent"
                        type="button"
                        onClick={() => onSearchEarlier?.()}
                    >
                        {t('common.retry')}
                    </button>
                </p>
            )}
            {canSearchEarlier && !hasLoadFailed && (
                <div className="flex shrink-0 justify-end px-2 pt-1">
                    <Button
                        aria-disabled={isLoadingEarlier}
                        className="gap-1 text-[12px] text-muted not-aria-disabled:hover:text-foreground"
                        size="sm"
                        variant="ghost"
                        onClick={() => {
                            if (!isLoadingEarlier) onSearchEarlier?.();
                        }}
                    >
                        <History aria-hidden="true" className="size-3.5" />
                        {t(
                            isLoadingEarlier
                                ? 'agentChat.find.searchingEarlier'
                                : 'agentChat.find.searchEarlier',
                        )}
                    </Button>
                </div>
            )}
        </>
    );
}
