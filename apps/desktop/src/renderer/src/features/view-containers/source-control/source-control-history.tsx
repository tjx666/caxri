import type {
    SourceControlAction,
    SourceControlFileHistory,
    SourceControlHistoryDescriptor,
} from '@caxri/protocol';
import { ChevronDown, ChevronRight } from 'lucide-react';

import { useRelativeTimes } from '@/hooks/use-relative-time';

import { DisclosureMotion } from '../../../components/disclosure-motion';
import { LoadingSkeleton } from '../../../components/loading-skeleton';
import { Spinner } from '../../../components/ui/spinner';
import { cn } from '../../../lib/utilities';
import { pushToast } from '../../../stores/toasts';
import { executeViewCatalogShortcut } from '../view-container-commands';
import type { SourceControlHistoryExpansion } from './hooks/use-source-control-history';
import { useSourceControlHistory } from './hooks/use-source-control-history';
import { SourceControlHistoryAvatar } from './source-control-history-avatar';
import { SourceControlHistoryDetails } from './source-control-history-details';
import { SourceControlHistoryHoverCard } from './source-control-history-hover-card';
import { SourceControlHistoryPathFilter } from './source-control-history-path-filter';
import { REFRESHING_ACTION_MESSAGE } from './source-control-history-state';
import { SourceControlIcon } from './source-control-icon';
import { SourceControlTreeRow } from './source-control-tree-row';

type FileHistoryScope = Pick<
    SourceControlFileHistory,
    'description' | 'emptyMessage' | 'label' | 'path' | 'tooltip'
> & { kind: 'file' };

/**
 * A commit-history disclosure inside the Source Control `role="tree"`.
 *
 * Every row it renders is a real `treeitem` in the tree's single roving tabindex: the section header, each commit, the
 * path filter, and `Load more`. They used to be plain buttons, which put a Tab stop on every commit and left the
 * section itself unreachable by arrow keys.
 *
 * `level` is the `aria-level` of the section header; its rows sit one level deeper, and a commit's changed files one
 * deeper again. `rowIdPrefix` namespaces this section's row ids: File History and a repository's `Commits` share one
 * `descriptor.id` (the repository id), so the prefix is what keeps their rows distinct.
 */
export function SourceControlHistory({
    descriptor,
    enabled = true,
    expansion,
    level,
    rowIdPrefix,
    runAction,
    scope,
}: {
    descriptor: SourceControlHistoryDescriptor;
    enabled?: boolean;
    expansion?: SourceControlHistoryExpansion;
    level: number;
    rowIdPrefix: string;
    runAction: (action: SourceControlAction) => void;
    scope?: FileHistoryScope;
}) {
    const {
        areActionsCurrent,
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
    } = useSourceControlHistory(descriptor, scope, expansion, enabled);
    const timeLabels = useRelativeTimes(items.map((item) => item.timestamp));
    const toggleExpanded = () => {
        setExpanded((value) => !value);
        if (!expanded) {
            // eslint-disable-next-line no-void -- the shared catalog dispatcher owns command failures
            void executeViewCatalogShortcut(
                descriptor.command.id,
                descriptor.command.arguments ?? [],
            );
        }
    };

    return (
        <section
            className={cn(
                'commit-history bg-surface',
                scope
                    ? 'file-history-section border-b border-border'
                    : !expanded && 'sticky bottom-0 z-10',
            )}
        >
            {scope ? (
                <SourceControlTreeRow
                    rowId={`${rowIdPrefix}:header`}
                    level={level}
                    className="file-history-row flex w-full cursor-pointer items-center gap-2 overflow-hidden border-0 bg-transparent p-2 text-left text-foreground hover:bg-elevated"
                    aria-label={scope.tooltip ? `${scope.label}: ${scope.tooltip}` : scope.label}
                    aria-expanded={expanded}
                    title={scope.tooltip}
                    onClick={toggleExpanded}
                >
                    <span className="flex shrink-0 items-center gap-1">
                        {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                        <SourceControlIcon icon={{ id: 'git-commit', kind: 'theme' }} size={12} />
                        <strong className="shrink-0 font-semibold whitespace-nowrap">
                            {scope.label}
                        </strong>
                    </span>
                    {scope.description && (
                        <span className="ml-auto min-w-0 truncate text-[11px] text-muted">
                            {scope.description}
                        </span>
                    )}
                </SourceControlTreeRow>
            ) : (
                <SourceControlTreeRow
                    rowId={`${rowIdPrefix}:header`}
                    level={level}
                    className="flex h-7 w-full cursor-pointer items-center gap-1 border-0 bg-transparent px-2 text-left text-[10px] font-bold tracking-[0.06em] text-muted uppercase hover:text-foreground"
                    aria-expanded={expanded}
                    onClick={toggleExpanded}
                >
                    {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                    <span className="truncate">{descriptor.label}</span>
                    {expanded && <span className="ml-auto">{items.length}</span>}
                </SourceControlTreeRow>
            )}
            <DisclosureMotion animate expanded={expanded} kind="git-history">
                {() => (
                    <div>
                        {!scope && (
                            <SourceControlHistoryPathFilter
                                clearPathLabel={descriptor.clearPathLabel}
                                inputLabel={descriptor.pathInputLabel}
                                level={level + 1}
                                placeholder={descriptor.pathInputPlaceholder}
                                rowId={`${rowIdPrefix}:path`}
                                setPath={setPath}
                                path={path}
                            />
                        )}
                        {error ? (
                            <div className="px-3 py-2 text-[11px] text-danger">{error}</div>
                        ) : loading && items.length === 0 ? (
                            <LoadingSkeleton
                                variant="list"
                                label={descriptor.loadingMessage}
                                rows={4}
                                indent={12}
                            />
                        ) : items.length === 0 ? (
                            <div className="px-3 py-2 text-[11px] text-muted">
                                {scope && !scope.path
                                    ? scope.emptyMessage
                                    : descriptor.emptyMessage}
                            </div>
                        ) : (
                            items.map((item, index) => (
                                <div key={item.id}>
                                    <SourceControlHistoryHoverCard
                                        descriptor={descriptor}
                                        detailsEnabled={areActionsCurrent}
                                        item={item}
                                        path={scopePath}
                                        timeLabel={timeLabels[index]}
                                        trigger={
                                            <SourceControlTreeRow
                                                rowId={`${rowIdPrefix}:commit:${item.id}`}
                                                level={level + 1}
                                                className={cn(
                                                    'commit-row flex w-full cursor-pointer gap-2 border-0 bg-surface px-3 py-1.5 text-left hover:bg-elevated',
                                                    selectedId === item.id && 'bg-elevated',
                                                )}
                                                aria-label={`${descriptor.itemAccessibilityLabelPrefix} ${item.label}`}
                                                {...(descriptor.itemActivation !== 'action' && {
                                                    'aria-expanded': selectedId === item.id,
                                                })}
                                                disabled={
                                                    descriptor.itemActivation === 'action' &&
                                                    !item.action
                                                }
                                                onClick={() => {
                                                    // Refused here rather than disabled above: a page whose revision
                                                    // the refresh has moved on from comes back several times a minute,
                                                    // and `disabled` drops the row out of the tree's single roving Tab
                                                    // stop each time; DESIGN.md's `Background refresh` rule.
                                                    if (!areActionsCurrent) {
                                                        pushToast(
                                                            'warning',
                                                            REFRESHING_ACTION_MESSAGE,
                                                        );
                                                        return;
                                                    }
                                                    if (descriptor.itemActivation === 'action') {
                                                        if (item.action) runAction(item.action);
                                                        return;
                                                    }
                                                    setSelectedId((current) =>
                                                        current === item.id ? undefined : item.id,
                                                    );
                                                }}
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
                                                            {timeLabels[index]}
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
                                            </SourceControlTreeRow>
                                        }
                                    />
                                    {areActionsCurrent &&
                                        descriptor.itemActivation !== 'action' &&
                                        selectedId === item.id && (
                                            <SourceControlHistoryDetails
                                                descriptor={descriptor}
                                                itemId={item.id}
                                                level={level + 2}
                                                path={scopePath}
                                                rowIdPrefix={`${rowIdPrefix}:commit:${item.id}`}
                                                runAction={runAction}
                                            />
                                        )}
                                </div>
                            ))
                        )}
                        {nextOffset !== undefined && (
                            <SourceControlTreeRow
                                rowId={`${rowIdPrefix}:load-more`}
                                level={level + 1}
                                className="load-more-commits flex h-7 w-full cursor-pointer items-center justify-center gap-1.5 border-0 bg-transparent text-[11px] text-muted hover:bg-elevated hover:text-foreground"
                                onClick={() => {
                                    // Every reason this row cannot act right now is transient, and this row is where
                                    // the keyboard usually is when a page lands: disabling it would hand the tree's
                                    // one Tab stop back to the first commit mid-scroll. The spinner already says a page
                                    // is in flight, and a filter the debounce has not caught up with corrects itself
                                    // within the same second, so only the stale-revision case is worth a sentence.
                                    if (loading || (!scope && path !== debouncedPath)) return;
                                    if (!areActionsCurrent) {
                                        pushToast('warning', REFRESHING_ACTION_MESSAGE);
                                        return;
                                    }
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
                            </SourceControlTreeRow>
                        )}
                    </div>
                )}
            </DisclosureMotion>
        </section>
    );
}
