import type { KeyboardEvent } from 'react';

import { formatCpuPercent, formatMemoryMb } from '@caxri/protocol';
import type { LucideIcon } from 'lucide-react';
import {
    AppWindow,
    Box,
    ChevronDown,
    ChevronRight,
    CircleStop,
    Cpu,
    MessageSquare,
    MonitorCog,
    Server,
    SquareTerminal,
    Terminal,
} from 'lucide-react';

import { Tooltip } from '../../components/ui/tooltip';
import { useTranslation } from '../../i18n';
import { cn } from '../../lib/utilities';
import { PROCESS_GRID_TEMPLATE } from './process-columns';
import type { ProcessTreeNodeKind, ProcessTreeRow } from './process-tree';

const processRowCellClassName = 'flex items-center justify-end px-3 tabular-nums';

const KIND_ICONS: Partial<Record<ProcessTreeNodeKind, LucideIcon>> = {
    gpu: MonitorCog,
    helper: Box,
    main: Cpu,
    process: Terminal,
    service: Server,
    session: MessageSquare,
    terminal: SquareTerminal,
    window: AppWindow,
};

/**
 * The disclosure chevron, or an equally wide spacer so leaf names stay aligned with their siblings.
 */
function ProcessDisclosure({
    isExpandable,
    isExpanded,
}: {
    isExpandable: boolean;
    isExpanded: boolean;
}) {
    if (!isExpandable) return <span className="process-indent w-3.5 shrink-0" />;
    const Chevron = isExpanded ? ChevronDown : ChevronRight;
    return <Chevron aria-hidden="true" className="w-3.5 shrink-0" size={14} />;
}

function ProcessNameCell({ row }: { row: ProcessTreeRow }) {
    const { t } = useTranslation();
    const { depth, isExpandable, isExpanded, node } = row;
    const Icon = KIND_ICONS[node.kind];
    return (
        <div
            role="gridcell"
            className="process-name-cell flex min-w-0 items-center gap-1.5 overflow-hidden"
            data-process-name={node.name}
            style={{ paddingLeft: 10 + depth * 18 }}
        >
            <ProcessDisclosure isExpandable={isExpandable} isExpanded={isExpanded} />
            {Icon && <Icon aria-hidden="true" className="shrink-0 text-muted" size={14} />}
            {node.isHigh && node.kind === 'terminal' && (
                <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full bg-warning" />
            )}
            <span
                className={cn(
                    'overflow-hidden text-ellipsis whitespace-nowrap',
                    node.kind === 'group' && 'text-[11px] tracking-[0.06em] uppercase',
                )}
            >
                {node.name}
            </span>
            {node.tag && (
                <span className="shrink-0 text-[11px] whitespace-nowrap text-muted">
                    {node.tag}
                </span>
            )}
            {node.isHigh && (
                <span className="sr-only">{t('processExplorer.row.highResource')}</span>
            )}
        </div>
    );
}

/**
 * The PID column; a Terminal row shows its Stop control there instead, since its own PID is one of several.
 */
function ProcessPidCell({
    node,
    onStopTerminal,
}: {
    node: ProcessTreeRow['node'];
    onStopTerminal: (terminalId: string, name: string) => void;
}) {
    const { t } = useTranslation();
    const { terminalId } = node;
    return (
        <span role="gridcell" className={cn(processRowCellClassName, 'text-muted')}>
            {terminalId ? (
                <Tooltip content={t('processExplorer.row.stopTooltip')}>
                    <button
                        type="button"
                        tabIndex={-1}
                        aria-label={t('processExplorer.row.stopLabel', { name: node.name })}
                        className="process-stop grid size-5.5 cursor-pointer place-items-center rounded border-0 bg-transparent p-0 text-muted opacity-0 group-hover/row:opacity-100 group-focus-visible/row:opacity-100 hover:bg-elevated hover:text-danger focus-visible:opacity-100"
                        onClick={(event) => {
                            event.stopPropagation();
                            onStopTerminal(terminalId, node.name);
                        }}
                    >
                        <CircleStop size={14} />
                    </button>
                </Tooltip>
            ) : (
                node.pid
            )}
        </span>
    );
}

/**
 * One row of the tree grid, and the element keyboard focus lands on. The row itself is the focus target rather than a
 * control inside it: the whole grid is a single Tab stop and arrow keys move between rows.
 *
 * A plain process row's tooltip carries the untruncated command line, which the short display name deliberately drops.
 * A Terminal row offers Stop on hover and focus; it suspends the Terminal, so the Session and the Agent conversation
 * survive.
 */
export function ProcessRow({
    isRoving,
    onKeyDown,
    onStopTerminal,
    onToggle,
    row,
}: {
    /**
     * True while this row owns the grid's single Tab stop.
     */
    isRoving: boolean;
    onKeyDown: (event: KeyboardEvent<HTMLDivElement>, row: ProcessTreeRow) => void;
    onStopTerminal: (terminalId: string, name: string) => void;
    onToggle: (row: ProcessTreeRow, isRecursive: boolean) => void;
    row: ProcessTreeRow;
}) {
    const { depth, isExpandable, isExpanded, node, positionInSet, setSize } = row;
    const content = (
        <div
            className={cn(
                'process-row group/row grid min-h-7 outline-none hover:bg-state-hover-ink-quiet',
                'focus-visible:bg-list-focus-background focus-visible:shadow-[inset_0_0_0_2px_var(--accent)]',
                isExpandable && 'cursor-pointer',
                node.kind === 'group' && 'min-h-8 font-semibold text-muted',
                node.isHigh && 'text-warning',
            )}
            role="row"
            aria-expanded={isExpandable ? isExpanded : undefined}
            aria-keyshortcuts={node.terminalId ? 'Delete' : undefined}
            aria-level={depth + 1}
            aria-posinset={positionInSet}
            aria-setsize={setSize}
            data-process-kind={node.kind}
            data-process-pid={node.pid}
            data-process-row-id={node.id}
            data-resource-high={node.isHigh || undefined}
            style={{ gridTemplateColumns: PROCESS_GRID_TEMPLATE }}
            tabIndex={isRoving ? 0 : -1}
            onClick={(event) => {
                if (isExpandable) onToggle(row, event.altKey);
            }}
            onKeyDown={(event) => onKeyDown(event, row)}
        >
            <ProcessNameCell row={row} />
            <span role="gridcell" className={processRowCellClassName}>
                {formatCpuPercent(node.cpuPercent)}
            </span>
            <span role="gridcell" className={processRowCellClassName}>
                {formatMemoryMb(node.memoryMb)}
            </span>
            <span role="gridcell" className={processRowCellClassName}>
                {node.ptyCount > 0 ? node.ptyCount : ''}
            </span>
            <ProcessPidCell node={node} onStopTerminal={onStopTerminal} />
        </div>
    );
    if (!node.command) return content;
    return (
        <Tooltip anchorMode="cursor" content={node.command}>
            {content}
        </Tooltip>
    );
}
