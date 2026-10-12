import { useEffect, useMemo, useRef, useState } from 'react';

import type { LogLevel, LogProcess, LogQueryRecord } from '@caxri/protocol';
import { useVirtualizer } from '@tanstack/react-virtual';
import { Trash2, X } from 'lucide-react';

import { LoadingSkeleton } from '../../../../components/loading-skeleton';
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
import type { TranslationKey } from '../../../../i18n';
import { useTranslation } from '../../../../i18n';
import { cn } from '../../../../lib/utilities';
import { filterLogRecords, parseLogFilter } from './log-filter';
import { useLogPrefillStore } from './log-prefill';
import { useLogStream } from './use-log-stream';

const ALL_PROCESSES = '__all__';

/**
 * Process names are Caxri's own component names (the same words the log records and docs use), so they stay English;
 * only the "all" choice is a phrase and carries a translation key.
 */
const PROCESS_OPTIONS: Array<{ value: string } & ({ label: string } | { labelKey: TranslationKey })> = [
    { value: ALL_PROCESSES, labelKey: 'panel.logs.allProcesses' },
    { value: 'desktop', label: 'Desktop' },
    { value: 'extension-host', label: 'Extension Host' },
    { value: 'server-core', label: 'Server Core' },
    { value: 'terminal-host', label: 'Terminal Host' },
];

const LEVELS: LogLevel[] = ['error', 'warn', 'info', 'debug'];

const LEVEL_TOGGLE_LABEL_KEYS: Record<LogLevel, TranslationKey> = {
    error: 'panel.logs.showLevel.error',
    warn: 'panel.logs.showLevel.warn',
    info: 'panel.logs.showLevel.info',
    debug: 'panel.logs.showLevel.debug',
};

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
    const { t } = useTranslation();
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
                        : t('panel.logs.noDetailFields')}
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
    const { t } = useTranslation();
    const processOptionLabel = (option: (typeof PROCESS_OPTIONS)[number]): string =>
        'labelKey' in option ? t(option.labelKey) : option.label;
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
                        <SelectTrigger aria-label={t('panel.logs.processFilter')} className="h-6 flex-1 text-[11px]">
                            <SelectValue>
                                {(() => {
                                    const selected = PROCESS_OPTIONS.find(
                                        ({ value }) => value === processValue,
                                    );
                                    return selected && processOptionLabel(selected);
                                })()}
                            </SelectValue>
                        </SelectTrigger>
                        <SelectContent>
                            {PROCESS_OPTIONS.map((option) => (
                                <SelectItem key={option.value} value={option.value}>
                                    {processOptionLabel(option)}
                                </SelectItem>
                            ))}
                        </SelectContent>
                    </Select>
                    <Tooltip content={t('panel.logs.clearViewTooltip')}>
                        <Button
                            aria-label={t('panel.logs.clearView')}
                            size="icon"
                            variant="ghost"
                            onClick={() => stream.clear()}
                        >
                            <Trash2 aria-hidden="true" size={13} />
                        </Button>
                    </Tooltip>
                </div>
                <div className="flex items-center gap-1">
                    <Tooltip content={t('panel.logs.filterGrammarHint')}>
                        <Input
                            aria-label={t('panel.logs.filterRecords')}
                            className="flex-1"
                            placeholder={t('panel.logs.filterPlaceholder')}
                            size="compact"
                            value={filterText}
                            onChange={(event) => setFilterText(event.currentTarget.value)}
                        />
                    </Tooltip>
                    <ToggleGroup
                        aria-label={t('panel.logs.levelFilter')}
                        multiple
                        value={activeLevels}
                        onValueChange={(next: LogLevel[]) => setActiveLevels(next)}
                    >
                        {LEVELS.map((level) => (
                            <ToggleGroupItem
                                key={level}
                                aria-label={t(LEVEL_TOGGLE_LABEL_KEYS[level])}
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
                                {t('panel.logs.visibleCount', {
                                    total: stream.records.length,
                                    visible: visible.length,
                                })}
                            </span>
                        )}
                        {hasActiveFilter && (
                            <Button
                                className="h-auto min-h-0 px-0 py-0 text-[11px] text-muted underline enabled:hover:bg-transparent enabled:hover:text-foreground"
                                size="sm"
                                variant="ghost"
                                onClick={clearFilters}
                            >
                                {t('panel.logs.clearFilters')}
                            </Button>
                        )}
                    </div>
                )}
            </div>
            {showGapBanner && (
                <div className="flex flex-none items-center gap-2 border-b border-border px-2 py-1 text-[11px] text-warning">
                    <span className="flex-1">
                        {t('panel.logs.gapNotice')}
                    </span>
                    <Button
                        aria-label={t('panel.logs.dismissGapNotice')}
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
                {visible.length === 0 && stream.isLoading ? (
                    <LoadingSkeleton
                        variant="document"
                        label={t('panel.logs.loading')}
                        lines={10}
                    />
                ) : visible.length === 0 ? (
                    <div className="flex flex-col items-center gap-1 px-3 py-4 text-center text-[12px] text-muted">
                        {hasActiveFilter ? (
                            <>
                                <span>{t('panel.logs.noFilteredRecords')}</span>
                                <Button size="sm" variant="ghost" onClick={clearFilters}>
                                    {t('panel.logs.clearFilters')}
                                </Button>
                            </>
                        ) : (
                            t('panel.logs.noRecords')
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
