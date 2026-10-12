import type { CSSProperties } from 'react';

import { ArrowDown, ArrowUp } from 'lucide-react';

import { useTranslation } from '../../i18n';
import { cn } from '../../lib/utilities';
import type { TableSort } from './csv-row-view';

/**
 * The pinned header row. Each column header is a button that cycles its sort (ascending, descending, file order) and
 * reports the current one through `aria-sort`, so the sort is reachable and announced from the keyboard.
 */
export function CsvTableHeader({
    header,
    numericColumns,
    sort,
    style,
    onSort,
}: {
    header: readonly string[];
    numericColumns: readonly boolean[];
    sort: TableSort | undefined;
    style: CSSProperties;
    onSort: (column: number) => void;
}) {
    const { t } = useTranslation();
    return (
        <div
            aria-rowindex={1}
            className="grid min-w-full border-b border-border bg-background font-semibold"
            role="row"
            style={style}
        >
            <span
                className="sticky left-0 border-r border-border bg-background"
                role="columnheader"
            >
                <span className="sr-only">{t('preview.table.rowHeader')}</span>
            </span>
            {header.map((label, column) => {
                const direction = sort?.column === column ? sort.direction : undefined;
                const SortIcon = direction === 'descending' ? ArrowDown : ArrowUp;
                return (
                    <span
                        // Columns are positional and never reorder, so the index is the header's identity.
                        key={column}
                        aria-sort={direction ?? 'none'}
                        className="min-w-0"
                        role="columnheader"
                    >
                        <button
                            className={cn(
                                'flex h-6 w-full min-w-0 cursor-pointer items-center gap-1 px-2 text-left font-semibold outline-none hover:bg-elevated focus-visible:bg-elevated',
                                numericColumns[column] && 'flex-row-reverse text-right',
                            )}
                            type="button"
                            onClick={() => onSort(column)}
                        >
                            <span className="min-w-0 truncate">{label}</span>
                            {direction && (
                                <SortIcon
                                    aria-hidden="true"
                                    className="flex-none text-muted"
                                    size={12}
                                />
                            )}
                        </button>
                    </span>
                );
            })}
        </div>
    );
}
