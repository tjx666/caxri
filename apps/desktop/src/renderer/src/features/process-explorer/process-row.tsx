import { ChevronDown, ChevronRight } from 'lucide-react';

import { Tooltip } from '../../components/ui/tooltip';
import { cn } from '../../lib/utilities';
import { PROCESS_GRID_TEMPLATE } from './process-columns';
import type { ProcessTreeNode } from './process-tree';

const processRowCellClassName = 'flex items-center px-3 border-l border-border tabular-nums';

export function ProcessRow({
    collapsed,
    depth,
    node,
    toggle,
}: {
    collapsed: Set<number>;
    depth: number;
    node: ProcessTreeNode;
    toggle: (node: ProcessTreeNode, isRecursive: boolean) => void;
}) {
    const isExpandable = node.children.length > 0;
    const isExpanded = isExpandable && !collapsed.has(node.pid);
    return (
        <>
            <div
                className="process-row grid min-h-7 hover:bg-[color-mix(in_srgb,var(--foreground)_6%,transparent)]"
                role="row"
                aria-level={depth + 1}
                aria-expanded={isExpandable ? isExpanded : undefined}
                data-process-pid={node.pid}
                style={{ gridTemplateColumns: PROCESS_GRID_TEMPLATE }}
            >
                <div
                    role="gridcell"
                    className="process-name-cell flex min-w-0 items-center"
                    style={{ paddingLeft: 14 + depth * 20 }}
                >
                    {/*
                     * The tooltip carries the untruncated command line, which is the whole point for a leaf process
                     * (an Agent CLI invocation runs far past any column width). It is why the name control stays an
                     * enabled button on a leaf row: a `disabled` button receives no pointer events in Chromium, so
                     * every leaf row silently lost its hover explanation.
                     */}
                    <Tooltip anchorMode="cursor" content={node.name}>
                        <button
                            type="button"
                            className={cn(
                                'process-name flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden border-0 bg-transparent p-0 text-left focus-visible:outline focus-visible:outline-1 focus-visible:-outline-offset-1 focus-visible:outline-foreground',
                                isExpandable ? 'cursor-pointer' : 'cursor-default',
                            )}
                            data-process-name={node.name}
                            onClick={(event) => {
                                if (isExpandable) toggle(node, event.altKey);
                            }}
                        >
                            {isExpandable ? (
                                isExpanded ? (
                                    <ChevronDown className="w-3.5 shrink-0" size={14} />
                                ) : (
                                    <ChevronRight className="w-3.5 shrink-0" size={14} />
                                )
                            ) : (
                                <span className="process-indent w-3.5 shrink-0" />
                            )}
                            <span className="overflow-hidden text-ellipsis whitespace-nowrap">
                                {node.name}
                            </span>
                        </button>
                    </Tooltip>
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
            {isExpanded &&
                node.children.map((child) => (
                    <ProcessRow
                        key={child.pid}
                        node={child}
                        depth={depth + 1}
                        collapsed={collapsed}
                        toggle={toggle}
                    />
                ))}
        </>
    );
}
