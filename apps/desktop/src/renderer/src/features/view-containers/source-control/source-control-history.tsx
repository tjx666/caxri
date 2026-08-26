import type { SourceControlAction, SourceControlHistoryDescriptor } from '@caxri/protocol';
import { relativeTime } from '@caxri/utils';
import { ChevronDown, ChevronRight, X } from 'lucide-react';

import { useNow } from '@/hooks/use-now';

import { DisclosureMotion } from '../../../components/disclosure-motion';
import { Button } from '../../../components/ui/button';
import { Input, InputGroup } from '../../../components/ui/input';
import { Spinner } from '../../../components/ui/spinner';
import { Tooltip } from '../../../components/ui/tooltip';
import { cn } from '../../../lib/utilities';
import { executeViewCatalogShortcut } from '../view-container-commands';
import { useSourceControlHistory } from './hooks/use-source-control-history';
import { SourceControlHistoryAvatar } from './source-control-history-avatar';
import { SourceControlHistoryDetails } from './source-control-history-details';
import { SourceControlHistoryHoverCard } from './source-control-history-hover-card';

export function SourceControlHistory({
    descriptor,
    runAction,
}: {
    descriptor: SourceControlHistoryDescriptor;
    runAction: (action: SourceControlAction) => void;
}) {
    const now = useNow(30_000);
    const {
        debouncedPath,
        error,
        expanded,
        items,
        loadPage,
        loading,
        nextOffset,
        path,
        scopePath,
        selectedId,
        setExpanded,
        setPath,
        setSelectedId,
    } = useSourceControlHistory(descriptor);

    return (
        <section className={cn('commit-history bg-surface', !expanded && 'sticky bottom-0 z-10')}>
            <button
                type="button"
                className="flex h-7 w-full cursor-pointer items-center gap-1 border-0 bg-transparent px-2 text-left text-[10px] font-bold tracking-[0.06em] text-muted uppercase hover:text-foreground"
                aria-expanded={expanded}
                onClick={() => {
                    setExpanded((value) => !value);
                    if (!expanded) {
                        // eslint-disable-next-line no-void -- the shared catalog dispatcher owns command failures
                        void executeViewCatalogShortcut(
                            descriptor.command.id,
                            descriptor.command.arguments ?? [],
                        );
                    }
                }}
            >
                {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                <span className="truncate">{descriptor.label}</span>
                {expanded && <span className="ml-auto">{items.length}</span>}
            </button>
            <DisclosureMotion animate expanded={expanded} kind="git-history">
                {() => (
                    <div>
                        <div className="border-y border-border p-1.5">
                            <InputGroup appearance="workbench" size="dense">
                                <Input
                                    appearance="embedded"
                                    className="flex-1 text-foreground"
                                    aria-label={descriptor.pathInputLabel}
                                    placeholder={descriptor.pathInputPlaceholder}
                                    size="dense"
                                    value={path}
                                    onChange={(event) => setPath(event.currentTarget.value)}
                                />
                                {path.length > 0 && (
                                    <Tooltip content={descriptor.clearPathLabel}>
                                        <button
                                            type="button"
                                            className="grid size-5 shrink-0 cursor-pointer place-items-center rounded border-0 bg-transparent p-0 text-muted hover:bg-elevated hover:text-foreground"
                                            aria-label={descriptor.clearPathLabel}
                                            onClick={() => setPath('')}
                                        >
                                            <X size={12} />
                                        </button>
                                    </Tooltip>
                                )}
                            </InputGroup>
                        </div>
                        {error ? (
                            <div className="px-3 py-2 text-[11px] text-danger">{error}</div>
                        ) : loading && items.length === 0 ? (
                            <div className="flex items-center gap-1.5 px-3 py-2 text-[11px] text-muted">
                                <Spinner size={12} /> {descriptor.loadingMessage}
                            </div>
                        ) : items.length === 0 ? (
                            <div className="px-3 py-2 text-[11px] text-muted">
                                {descriptor.emptyMessage}
                            </div>
                        ) : (
                            items.map((item) => (
                                <div key={item.id}>
                                    <SourceControlHistoryHoverCard
                                        descriptor={descriptor}
                                        item={item}
                                        now={now}
                                        path={scopePath}
                                        trigger={
                                            <button
                                                type="button"
                                                className={cn(
                                                    'commit-row flex w-full cursor-pointer gap-2 border-0 bg-surface px-3 py-1.5 text-left hover:bg-elevated',
                                                    selectedId === item.id && 'bg-elevated',
                                                )}
                                                aria-label={`${descriptor.itemAccessibilityLabelPrefix} ${item.label}`}
                                                onClick={() =>
                                                    setSelectedId((current) =>
                                                        current === item.id ? undefined : item.id,
                                                    )
                                                }
                                            >
                                                <SourceControlHistoryAvatar
                                                    className="mt-0.5"
                                                    item={item}
                                                />
                                                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                                                    <span className="flex w-full min-w-0 items-center gap-2">
                                                        <span className="truncate text-foreground">
                                                            {item.label}
                                                        </span>
                                                        <code className="ml-auto shrink-0 text-[10px] text-muted">
                                                            {item.description}
                                                        </code>
                                                    </span>
                                                    <span className="flex w-full min-w-0 items-center gap-1 text-[10px] text-muted">
                                                        <span className="truncate">
                                                            {item.author}
                                                        </span>
                                                        <span>·</span>
                                                        <time
                                                            dateTime={new Date(
                                                                item.timestamp,
                                                            ).toISOString()}
                                                            title={item.tooltipTimestamp}
                                                        >
                                                            {relativeTime(item.timestamp, now)}
                                                        </time>
                                                    </span>
                                                    {item.decorations.length > 0 && (
                                                        <span className="flex max-w-full gap-1 overflow-hidden">
                                                            {item.decorations.map((decoration) => (
                                                                <span
                                                                    className="truncate rounded bg-elevated px-1 text-[10px] text-muted"
                                                                    key={decoration}
                                                                >
                                                                    {decoration}
                                                                </span>
                                                            ))}
                                                        </span>
                                                    )}
                                                </span>
                                            </button>
                                        }
                                    />
                                    {selectedId === item.id && (
                                        <SourceControlHistoryDetails
                                            descriptor={descriptor}
                                            itemId={item.id}
                                            path={scopePath}
                                            runAction={runAction}
                                        />
                                    )}
                                </div>
                            ))
                        )}
                        {nextOffset !== undefined && (
                            <Button
                                className="load-more-commits h-7 w-full gap-1.5 rounded-none text-[11px] text-muted hover:text-foreground"
                                size="sm"
                                variant="ghost"
                                disabled={loading || path !== debouncedPath}
                                onClick={() => {
                                    // eslint-disable-next-line no-void -- loadPage owns its loading and error state
                                    void loadPage(nextOffset, false);
                                }}
                            >
                                {loading ? (
                                    <>
                                        <Spinner size={11} /> {descriptor.loadingMoreLabel}
                                    </>
                                ) : (
                                    descriptor.loadMoreLabel
                                )}
                            </Button>
                        )}
                    </div>
                )}
            </DisclosureMotion>
        </section>
    );
}
