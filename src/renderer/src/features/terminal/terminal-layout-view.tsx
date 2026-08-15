import type { CSSProperties, PointerEvent } from 'react';
import { useMemo, useRef, useState } from 'react';

import { moveTerminal, resizeSplit, splitTerminal } from '@shared/terminal-layout';
import type {
    TerminalGroupNode,
    TerminalLayout,
    TerminalLayoutNode,
    TerminalSplitNode,
} from '@shared/types';

import { cn } from '../../lib/utilities';
import { useSessionState, useSessionTerminals } from '../../stores/selectors';
import { activateTerminal, applyTerminalLayout, TERMINAL_DRAG_TYPE } from './terminal-actions';
import { TerminalPane } from './terminal-pane';

type DropZone = 'center' | 'right' | 'down';

const fullBleedClassName = 'h-full w-full min-h-0 min-w-0';

/**
The focused pane ring is the app's one accent indicator (DESIGN.md "Terminal panes").
 */
const terminalGroupClassName = cn('terminal-group', fullBleedClassName, 'relative');

const terminalDropPreviewClassName =
    'absolute z-[5] grid place-items-center border border-accent bg-[color-mix(in_srgb,var(--accent)_24%,transparent)] text-foreground text-[11px] pointer-events-none';

const dropZoneClassName: Record<DropZone, string> = {
    center: 'inset-[18%]',
    right: 'inset-[0_0_0_50%]',
    down: 'inset-[50%_0_0]',
};

/**
 * Only the structural facts travel down the recursion. Presentation inputs (theme, font size,
 * scrollback, attach epoch) and callbacks are read from the stores by the node that needs them, so a
 * snapshot refresh no longer rerenders every node in the tree.
 */
interface NodeViewProperties {
    groupNumbers: Map<string, number>;
    layout: TerminalLayout;
    node: TerminalLayoutNode;
}

function groupNumbers(root?: TerminalLayoutNode): Map<string, number> {
    const result = new Map<string, number>();
    const visit = (node?: TerminalLayoutNode): void => {
        if (!node) return;
        if (node.type === 'group') {
            result.set(node.id, result.size + 1);
            return;
        }
        visit(node.first);
        visit(node.second);
    };
    visit(root);
    return result;
}

function dropZone(event: React.DragEvent<HTMLElement>): DropZone {
    const bounds = event.currentTarget.getBoundingClientRect();
    const horizontal = (event.clientX - bounds.left) / bounds.width;
    if (horizontal > 0.67) return 'right';
    const vertical = (event.clientY - bounds.top) / bounds.height;
    if (vertical > 0.67) return 'down';
    return 'center';
}

function TerminalGroupView(properties: NodeViewProperties & { node: TerminalGroupNode }) {
    const [activeDropZone, setActiveDropZone] = useState<DropZone>();
    const terminals = useSessionTerminals();
    const terminalId =
        properties.node.activeTerminalId &&
        properties.node.terminalIds.includes(properties.node.activeTerminalId)
            ? properties.node.activeTerminalId
            : properties.node.terminalIds[0];
    const terminal = terminals.find((candidate) => candidate.id === terminalId);
    if (!terminal) return null;
    const isActive = properties.layout.activeGroupId === properties.node.id;
    const applyDrop = (event: React.DragEvent<HTMLDivElement>): void => {
        event.preventDefault();
        const draggedTerminalId =
            event.dataTransfer.getData(TERMINAL_DRAG_TYPE) ||
            event.dataTransfer.getData('text/plain');
        const zone = dropZone(event);
        setActiveDropZone(undefined);
        if (!draggedTerminalId) return;
        const next =
            zone === 'center'
                ? moveTerminal(properties.layout, draggedTerminalId, properties.node.id)
                : splitTerminal(
                      properties.layout,
                      draggedTerminalId,
                      properties.node.id,
                      zone === 'right' ? 'horizontal' : 'vertical',
                  );
        applyTerminalLayout(next);
        activateTerminal(draggedTerminalId);
    };
    const label = `Terminal group ${properties.groupNumbers.get(properties.node.id) ?? 1}: ${terminal.title}`;
    return (
        <div
            className={cn(
                terminalGroupClassName,
                isActive &&
                    'active shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--accent)_55%,transparent)]',
            )}
            data-drop-zone={activeDropZone}
            data-group-id={properties.node.id}
            onDragEnter={(event) => {
                event.preventDefault();
                setActiveDropZone(dropZone(event));
            }}
            onDragLeave={(event) => {
                if (!event.currentTarget.contains(event.relatedTarget as Node | null))
                    setActiveDropZone(undefined);
            }}
            onDragOver={(event) => {
                event.preventDefault();
                event.dataTransfer.dropEffect = 'move';
                setActiveDropZone(dropZone(event));
            }}
            onDrop={applyDrop}
        >
            <TerminalPane active={isActive} ariaLabel={label} terminalId={terminal.id} />
            {activeDropZone && (
                <div
                    className={cn(
                        `terminal-drop-preview terminal-drop-${activeDropZone}`,
                        terminalDropPreviewClassName,
                        dropZoneClassName[activeDropZone],
                    )}
                >
                    {activeDropZone === 'center'
                        ? 'Move to group'
                        : activeDropZone === 'right'
                          ? 'Split right'
                          : 'Split down'}
                </div>
            )}
        </div>
    );
}

function TerminalSplitView(properties: NodeViewProperties & { node: TerminalSplitNode }) {
    const dragging = useRef(false);
    const [draftRatio, setDraftRatio] = useState<number>();
    const ratio = draftRatio ?? properties.node.ratio;
    const isHorizontal = properties.node.direction === 'horizontal';
    const updateRatio = (event: PointerEvent<HTMLDivElement>): number => {
        const container = event.currentTarget.parentElement;
        if (!container) return ratio;
        const bounds = container.getBoundingClientRect();
        const next = isHorizontal
            ? (event.clientX - bounds.left) / bounds.width
            : (event.clientY - bounds.top) / bounds.height;
        return Math.min(0.85, Math.max(0.15, next));
    };
    const firstStyle = {
        flexBasis: `${ratio * 100}%`,
    } satisfies CSSProperties;
    return (
        <div
            className={cn(
                `terminal-split terminal-split-${properties.node.direction}`,
                fullBleedClassName,
                'flex',
                isHorizontal ? 'flex-row' : 'flex-col',
            )}
            data-split-id={properties.node.id}
        >
            <div
                className={cn('terminal-layout-child', fullBleedClassName, 'flex-1')}
                style={firstStyle}
            >
                <TerminalNodeView {...properties} node={properties.node.first} />
            </div>
            <div
                role="separator"
                tabIndex={0}
                className={cn(
                    'terminal-splitter',
                    'relative z-[3] flex-none basis-1 border-0 bg-border',
                    'hover:bg-accent focus-visible:bg-accent focus-visible:outline-none',
                    isHorizontal ? 'cursor-col-resize' : 'cursor-row-resize',
                )}
                aria-label={`Resize ${isHorizontal ? 'horizontal' : 'vertical'} Terminal split`}
                aria-orientation={isHorizontal ? 'vertical' : 'horizontal'}
                aria-valuemin={15}
                aria-valuemax={85}
                aria-valuenow={Math.round(ratio * 100)}
                onKeyDown={(event) => {
                    const isDecrease = isHorizontal
                        ? event.key === 'ArrowLeft'
                        : event.key === 'ArrowUp';
                    const isIncrease = isHorizontal
                        ? event.key === 'ArrowRight'
                        : event.key === 'ArrowDown';
                    if (!isDecrease && !isIncrease) return;
                    event.preventDefault();
                    applyTerminalLayout(
                        resizeSplit(
                            properties.layout,
                            properties.node.id,
                            ratio + (isDecrease ? -0.05 : 0.05),
                        ),
                    );
                }}
                onPointerDown={(event) => {
                    dragging.current = true;
                    event.currentTarget.setPointerCapture(event.pointerId);
                }}
                onPointerMove={(event) => {
                    if (dragging.current) setDraftRatio(updateRatio(event));
                }}
                onPointerUp={(event) => {
                    if (!dragging.current) return;
                    dragging.current = false;
                    const nextRatio = updateRatio(event);
                    setDraftRatio(undefined);
                    applyTerminalLayout(
                        resizeSplit(properties.layout, properties.node.id, nextRatio),
                    );
                }}
                onPointerCancel={() => {
                    dragging.current = false;
                    setDraftRatio(undefined);
                }}
                onLostPointerCapture={() => {
                    dragging.current = false;
                    setDraftRatio(undefined);
                }}
            />
            <div className={cn('terminal-layout-child', fullBleedClassName, 'flex-1')}>
                <TerminalNodeView {...properties} node={properties.node.second} />
            </div>
        </div>
    );
}

function TerminalNodeView(properties: NodeViewProperties) {
    return properties.node.type === 'group' ? (
        <TerminalGroupView {...properties} node={properties.node} />
    ) : (
        <TerminalSplitView {...properties} node={properties.node} />
    );
}

export function TerminalLayoutView() {
    const layout = useSessionState()?.layout;
    const numbers = useMemo(() => groupNumbers(layout?.root), [layout?.root]);
    if (!layout?.root) return null;
    return <TerminalNodeView layout={layout} node={layout.root} groupNumbers={numbers} />;
}
