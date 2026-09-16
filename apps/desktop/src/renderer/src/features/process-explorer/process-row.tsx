import type { KeyboardEvent } from 'react';

import { ChevronDown, ChevronRight } from 'lucide-react';

import { Tooltip } from '../../components/ui/tooltip';
import { cn } from '../../lib/utilities';
import { PROCESS_GRID_TEMPLATE } from './process-columns';
import type { ProcessTreeRow } from './process-tree';

const processRowCellClassName = 'flex items-center px-3 border-l border-border tabular-nums';

/**
 * One process in the tree grid, and the element keyboard focus lands on. The row itself is the focus target rather than
 * a control inside it: the whole grid is a single Tab stop and arrow keys move between rows, so a leaf — which has no
 * action at all — renders no control. It used to render its name as a `<button>` on every row, giving each row its own
 * Tab stop and putting a pressable control on leaves where pressing it did nothing.
 *
 * The tooltip carries the untruncated command line, which is the whole point for a leaf process (an Agent CLI
 * invocation runs far past any column width). It hangs off the row so the pointer and the keyboard both reach it.
 */
export function ProcessRow({
    isRoving,
    onKeyDown,
    onToggle,
    row,
}: {
    /**
     * True while this row owns the grid's single Tab stop.
     */
    isRoving: boolean;
    onKeyDown: (event: KeyboardEvent<HTMLDivElement>, row: ProcessTreeRow) => void;
    onToggle: (row: ProcessTreeRow, isRecursive: boolean) => void;
    row: ProcessTreeRow;
}) {
    const { depth, isExpandable, isExpanded, node, positionInSet, setSize } = row;
    return (
        <Tooltip anchorMode="cursor" content={node.name}>
            <div
                className={cn(
                    'process-row grid min-h-7 outline-none hover:bg-[color-mix(in_srgb,var(--foreground)_6%,transparent)]',
                    'focus-visible:bg-list-focus-background focus-visible:shadow-[inset_0_0_0_2px_var(--accent)]',
                    isExpandable && 'cursor-pointer',
                )}
                role="row"
                aria-expanded={isExpandable ? isExpanded : undefined}
                aria-level={depth + 1}
                aria-posinset={positionInSet}
                aria-setsize={setSize}
                data-process-pid={node.pid}
                style={{ gridTemplateColumns: PROCESS_GRID_TEMPLATE }}
                tabIndex={isRoving ? 0 : -1}
                onClick={(event) => {
                    if (isExpandable) onToggle(row, event.altKey);
                }}
                onKeyDown={(event) => onKeyDown(event, row)}
            >
                <div
                    role="gridcell"
                    className="process-name-cell flex min-w-0 items-center gap-1.5 overflow-hidden"
                    data-process-name={node.name}
                    style={{ paddingLeft: 14 + depth * 20 }}
                >
                    {isExpandable ? (
                        isExpanded ? (
                            <ChevronDown aria-hidden="true" className="w-3.5 shrink-0" size={14} />
                        ) : (
                            <ChevronRight aria-hidden="true" className="w-3.5 shrink-0" size={14} />
                        )
                    ) : (
                        <span className="process-indent w-3.5 shrink-0" />
                    )}
                    <span className="overflow-hidden text-ellipsis whitespace-nowrap">
                        {node.name}
                    </span>
                </div>
                <span role="gridcell" className={processRowCellClassName}>
                    {node.cpuPercent.toFixed(1)}
                </span>
                <span role="gridcell" className={processRowCellClassName}>
                    {node.memoryMb.toFixed(1)}
                </span>
                <span role="gridcell" className={processRowCellClassName}>
                    {node.pid}
                </span>
            </div>
        </Tooltip>
    );
}
