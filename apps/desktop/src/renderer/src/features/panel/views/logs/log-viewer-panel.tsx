import { useEffect, useMemo, useRef, useState } from 'react';

import type { LogLevel, LogProcess, LogQueryRecord } from '@caxri/protocol';
import { useVirtualizer } from '@tanstack/react-virtual';
import { Trash2, X } from 'lucide-react';

import { Button } from '../../../../components/ui/button';
import { Input } from '../../../../components/ui/input';
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from '../../../../components/ui/select';
import { ToggleGroup, ToggleGroupItem } from '../../../../components/ui/toggle-group';
import { Tooltip } from '../../../../components/ui/tooltip';
import { cn } from '../../../../lib/utilities';
import { filterLogRecords, parseLogFilter } from './log-filter';
import { useLogPrefillStore } from './log-prefill';
import { useLogStream } from './use-log-stream';

const FILTER_GRAMMAR_HINT =
    'Comma-separates patterns as OR (a, b). Prefix a pattern with ! to exclude it (!a). Wrap a pattern in double quotes to match a literal comma or leading ! ("a,b", !"c").';

const ALL_PROCESSES = '__all__';

const PROCESS_OPTIONS: Array<{ value: string; label: string }> = [
    { value: ALL_PROCESSES, label: 'All processes' },
    { value: 'desktop', label: 'Desktop' },
    { value: 'extension-host', label: 'Extension Host' },
    { value: 'server-core', label: 'Server Core' },
    { value: 'terminal-host', label: 'Terminal Host' },
];

const LEVELS: LogLevel[] = ['error', 'warn', 'info', 'debug'];

const levelClass: Record<LogLevel, string> = {
    error: 'text-danger',
    warn: 'text-warning',
    info: 'text-foreground',
    debug: 'text-muted',
};

function formatLogTime(timestamp: string): string {
    const date = new Date(timestamp);
    const pad = (value: number, width = 2) => String(value).padStart(width, '0');
    return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`;
}

function LogRow({
    record,
    expanded,
    onToggle,
}: {
    record: LogQueryRecord;
    expanded: boolean;
    onToggle(): void;
}) {
    return (
        <button
            type="button"
            aria-expanded={expanded}
            className="block w-full cursor-pointer border-0 border-b border-b-border/50 bg-transparent px-2 py-0.5 text-left font-mono text-[11px] leading-4 text-inherit hover:bg-elevated"
            onClick={onToggle}
        >
            <div className={cn('flex gap-1.5', !expanded && 'overflow-hidden')}>
                <span className="flex-none text-muted">{formatLogTime(record.timestamp)}</span>
                <span className="flex-none text-muted">{record.process}</span>
                <span className={cn('min-w-0', levelClass[record.level], !expanded && 'truncate')}>
                    {record.event}
                </span>
                {record.durationMs !== undefined && (
                    <span className="ml-auto flex-none text-muted">
                        {Math.round(record.durationMs)}ms
                    </span>
                )}
            </div>
            {expanded && (
                <div className="mt-0.5 text-muted [overflow-wrap:anywhere] whitespace-pre-wrap">
                    {record.correlationId && `correlationId: ${record.correlationId}\n`}
                    {record.fields
                        ? JSON.stringify(record.fields, undefined, 2)
                        : 'No detail fields.'}
                </div>
            )}
        </button>
    );
}

/**
 * VS Code Output-panel style structured log viewer over `logs.query`: server-side process filter, client-side level
 * toggles and text filter (comma OR, `!` exclude, quotes), cursor-follow polling, and smart scroll: the view follows
 * the tail until the user scrolls up, and re-locks when they return to the bottom.
 */
export function LogViewerPanel() {
    const [processValue, setProcessValue] = useState<string>(ALL_PROCESSES);
    const [activeLevels, setActiveLevels] = useState<LogLevel[]>([...LEVELS]);
    const [filterText, setFilterText] = useState('');
    const [expandedId, setExpandedId] = useState<string>();
    const [follow, setFollow] = useState(true);
    // The epoch the user last dismissed the gap banner at (see `log-stream.ts`'s `gapEpoch` doc
    // comment); the banner re-shows once `stream.gapEpoch` moves past it.
    const [dismissedGapEpoch, setDismissedGapEpoch] = useState(0);
    const scrollReference = useRef<HTMLDivElement>(null);

    const process = processValue === ALL_PROCESSES ? undefined : (processValue as LogProcess);
    const stream = useLogStream(process);

    /*
     * Applied on mount as well as while open, because "Open Logs" usually reaches a panel that is not showing yet: the
     * same click activates the view container that mounts this component. Taking the request clears it, so a later
     * manual visit opens on whatever the user left rather than on a query from an error they already dealt with.
     */
    const pendingPrefill = useLogPrefillStore((state) => state.pending);
    const consumeLogPrefill = useLogPrefillStore((state) => state.consumeLogPrefill);
    useEffect(() => {
        if (!pendingPrefill) return;
        setFilterText(pendingPrefill.filter);
        setActiveLevels([...pendingPrefill.levels]);
        consumeLogPrefill();
    }, [consumeLogPrefill, pendingPrefill]);

    const filter = useMemo(() => parseLogFilter(filterText), [filterText]);
    const visible = useMemo(
        () => filterLogRecords(stream.records, activeLevels, filter),
        [stream.records, activeLevels, filter],
    );
    const hasActiveFilter = filterText.trim() !== '' || activeLevels.length !== LEVELS.length;
    const clearFilters = (): void => {
        setFilterText('');
        setActiveLevels([...LEVELS]);
    };
    const showGapBanner = stream.gap && stream.gapEpoch > dismissedGapEpoch;

    // TanStack Virtual is knowingly incompatible with React Compiler memoization; the compiler
    // skips this component, which is the library's documented, expected behavior.
    // eslint-disable-next-line react-hooks/incompatible-library -- see above
    const virtualizer = useVirtualizer({
        count: visible.length,
        estimateSize: () => 21,
        getItemKey: (index) => visible[index].id,
        getScrollElement: () => scrollReference.current,
        overscan: 20,
    });

    const lastKey = visible.at(-1)?.id;
    useEffect(() => {
        if (follow && visible.length > 0)
            virtualizer.scrollToIndex(visible.length - 1, { align: 'end' });
        // `lastKey` (not the array) is the dependency so appends re-lock the tail without reacting to re-filters.
    }, [follow, lastKey, visible.length, virtualizer]);

    const handleScroll = (): void => {
        const element = scrollReference.current;
        if (!element) return;
        setFollow(element.scrollHeight - element.scrollTop - element.clientHeight < 8);
    };

    return (
        <div className="flex h-full min-h-0 flex-col">
            <div className="flex flex-none flex-col gap-1 border-b border-border p-2">
                <div className="flex items-center gap-1">
                    <Select
                        value={processValue}
                        onValueChange={(next) => setProcessValue(next ?? ALL_PROCESSES)}
                    >
                        <SelectTrigger aria-label="Process filter" className="h-6 flex-1 text-[11px]">
                            <SelectValue>
                                {PROCESS_OPTIONS.find(({ value }) => value === processValue)?.label}
                            </SelectValue>
                        </SelectTrigger>
                        <SelectContent>
                            {PROCESS_OPTIONS.map(({ value, label }) => (
                                <SelectItem key={value} value={value}>
                                    {label}
                                </SelectItem>
                            ))}
                        </SelectContent>
                    </Select>
                    <Tooltip content="Clear the view (history stays on disk)">
                        <Button
                            aria-label="Clear log view"
                            size="icon"
                            variant="ghost"
                            onClick={() => stream.clear()}
                        >
                            <Trash2 aria-hidden="true" size={13} />
                        </Button>
                    </Tooltip>
                </div>
                <div className="flex items-center gap-1">
                    <Tooltip content={FILTER_GRAMMAR_HINT}>
                        <Input
                            aria-label="Filter log records"
                            className="flex-1"
                            placeholder="Filter (e.g. text, !exclude)"
                            size="compact"
                            value={filterText}
                            onChange={(event) => setFilterText(event.currentTarget.value)}
                        />
                    </Tooltip>
                    <ToggleGroup
                        aria-label="Level filter"
                        multiple
                        value={activeLevels}
                        onValueChange={(next: LogLevel[]) => setActiveLevels(next)}
                    >
                        {LEVELS.map((level) => (
                            <ToggleGroupItem
                                key={level}
                                aria-label={`Show ${level} records`}
                                value={level}
                            >
                                {level.slice(0, 1).toUpperCase()}
                            </ToggleGroupItem>
                        ))}
                    </ToggleGroup>
                </div>
                {(hasActiveFilter || visible.length !== stream.records.length) && (
                    <div className="flex items-center gap-2 text-[11px] text-muted">
                        {visible.length !== stream.records.length && (
                            <span>
                                {visible.length} of {stream.records.length}
                            </span>
                        )}
                        {hasActiveFilter && (
                            <Button
                                className="h-auto min-h-0 px-0 py-0 text-[11px] text-muted underline enabled:hover:bg-transparent enabled:hover:text-foreground"
                                size="sm"
                                variant="ghost"
                                onClick={clearFilters}
                            >
                                Clear filters
                            </Button>
                        )}
                    </div>
                )}
            </div>
            {showGapBanner && (
                <div className="flex flex-none items-center gap-2 border-b border-border px-2 py-1 text-[11px] text-warning">
                    <span className="flex-1">
                        Some records rotated out before they could be fetched.
                    </span>
                    <Button
                        aria-label="Dismiss dropped-records notice"
                        className="text-warning enabled:hover:bg-[color-mix(in_srgb,var(--warning)_18%,transparent)]"
                        size="icon"
                        variant="ghost"
                        onClick={() => setDismissedGapEpoch(stream.gapEpoch)}
                    >
                        <X aria-hidden="true" size={13} />
                    </Button>
                </div>
            )}
            <div ref={scrollReference} className="min-h-0 flex-1 overflow-auto" onScroll={handleScroll}>
                {visible.length === 0 ? (
                    <div className="flex flex-col items-center gap-1 px-3 py-4 text-center text-[12px] text-muted">
                        {stream.isLoading ? (
                            'Loading logs…'
                        ) : hasActiveFilter ? (
                            <>
                                <span>No log records match the filter text or level toggles.</span>
                                <Button size="sm" variant="ghost" onClick={clearFilters}>
                                    Clear filters
                                </Button>
                            </>
                        ) : (
                            'No log records match.'
                        )}
                    </div>
                ) : (
                    <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
                        {virtualizer.getVirtualItems().map((item) => {
                            const record = visible[item.index];
                            return (
                                <div
                                    key={item.key}
                                    ref={virtualizer.measureElement}
                                    data-index={item.index}
                                    className="absolute top-0 left-0 w-full"
                                    style={{ transform: `translateY(${item.start}px)` }}
                                >
                                    <LogRow
                                        record={record}
                                        expanded={expandedId === record.id}
                                        onToggle={() =>
                                            setExpandedId((current) =>
                                                current === record.id ? undefined : record.id,
                                            )
                                        }
                                    />
                                </div>
                            );
                        })}
                    </div>
                )}
            </div>
        </div>
    );
}
