import { useMemo, useRef, useState, type CSSProperties, type PointerEvent } from 'react';

import { moveTerminal, resizeSplit, splitTerminal } from '@shared/terminal-layout';
import type {
    TerminalGroupNode,
    TerminalLayout,
    TerminalLayoutNode,
    TerminalSplitNode,
} from '@shared/types';

import { useSessionState, useSessionTerminals } from '../../state/selectors';
import { activateTerminal, applyTerminalLayout } from './terminal-actions';
import { TerminalPane } from './TerminalPane';
import { TERMINAL_DRAG_TYPE } from './terminal-view-commands';

type DropZone = 'center' | 'right' | 'down';

/**
 * Only the structural facts travel down the recursion. Presentation inputs (theme, font size,
 * scrollback, attach epoch) and callbacks are read from the stores by the node that needs them, so a
 * snapshot refresh no longer rerenders every node in the tree.
 */
interface NodeViewProps {
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
    const vertical = (event.clientY - bounds.top) / bounds.height;
    if (horizontal > 0.67) return 'right';
    if (vertical > 0.67) return 'down';
    return 'center';
}

function TerminalGroupView(props: NodeViewProps & { node: TerminalGroupNode }) {
    const [activeDropZone, setActiveDropZone] = useState<DropZone>();
    const terminals = useSessionTerminals();
    const terminalId =
        props.node.activeTerminalId && props.node.terminalIds.includes(props.node.activeTerminalId)
            ? props.node.activeTerminalId
            : props.node.terminalIds[0];
    const terminal = terminals.find((candidate) => candidate.id === terminalId);
    const isActive = props.layout.activeGroupId === props.node.id;
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
                ? moveTerminal(props.layout, draggedTerminalId, props.node.id)
                : splitTerminal(
                      props.layout,
                      draggedTerminalId,
                      props.node.id,
                      zone === 'right' ? 'horizontal' : 'vertical',
                  );
        applyTerminalLayout(next);
        activateTerminal(draggedTerminalId);
    };
    if (!terminal) return null;
    const label = `Terminal group ${props.groupNumbers.get(props.node.id) ?? 1}: ${terminal.title}`;
    return (
        <div
            className={isActive ? 'terminal-group active' : 'terminal-group'}
            data-drop-zone={activeDropZone}
            data-group-id={props.node.id}
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
                <div className={`terminal-drop-preview terminal-drop-${activeDropZone}`}>
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

function TerminalSplitView(props: NodeViewProps & { node: TerminalSplitNode }) {
    const dragging = useRef(false);
    const [draftRatio, setDraftRatio] = useState<number>();
    const ratio = draftRatio ?? props.node.ratio;
    const horizontal = props.node.direction === 'horizontal';
    const updateRatio = (event: PointerEvent<HTMLDivElement>): number => {
        const container = event.currentTarget.parentElement;
        if (!container) return ratio;
        const bounds = container.getBoundingClientRect();
        const next = horizontal
            ? (event.clientX - bounds.left) / bounds.width
            : (event.clientY - bounds.top) / bounds.height;
        return Math.min(0.85, Math.max(0.15, next));
    };
    const firstStyle = {
        flexBasis: `${ratio * 100}%`,
    } satisfies CSSProperties;
    return (
        <div
            className={`terminal-split terminal-split-${props.node.direction}`}
            data-split-id={props.node.id}
        >
            <div className="terminal-layout-child" style={firstStyle}>
                <TerminalNodeView {...props} node={props.node.first} />
            </div>
            <div
                role="separator"
                tabIndex={0}
                className="terminal-splitter"
                aria-label={`Resize ${horizontal ? 'horizontal' : 'vertical'} Terminal split`}
                aria-orientation={horizontal ? 'vertical' : 'horizontal'}
                aria-valuemin={15}
                aria-valuemax={85}
                aria-valuenow={Math.round(ratio * 100)}
                onKeyDown={(event) => {
                    const decrease = horizontal
                        ? event.key === 'ArrowLeft'
                        : event.key === 'ArrowUp';
                    const increase = horizontal
                        ? event.key === 'ArrowRight'
                        : event.key === 'ArrowDown';
                    if (!decrease && !increase) return;
                    event.preventDefault();
                    applyTerminalLayout(
                        resizeSplit(props.layout, props.node.id, ratio + (decrease ? -0.05 : 0.05)),
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
                    applyTerminalLayout(resizeSplit(props.layout, props.node.id, nextRatio));
                }}
            />
            <div className="terminal-layout-child">
                <TerminalNodeView {...props} node={props.node.second} />
            </div>
        </div>
    );
}

function TerminalNodeView(props: NodeViewProps) {
    return props.node.type === 'group' ? (
        <TerminalGroupView {...props} node={props.node} />
    ) : (
        <TerminalSplitView {...props} node={props.node} />
    );
}

export function TerminalLayoutView() {
    const layout = useSessionState()?.layout;
    const numbers = useMemo(() => groupNumbers(layout?.root), [layout?.root]);
    if (!layout?.root) return null;
    return <TerminalNodeView layout={layout} node={layout.root} groupNumbers={numbers} />;
}
