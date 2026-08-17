import type { CSSProperties, DragEvent } from 'react';
import { useMemo, useState } from 'react';

import { findPathGroupId, sessionEditorLayout } from '@shared/editor-layout';
import type {
    EditorGroupNode,
    EditorLayout,
    EditorLayoutNode,
    EditorSplitNode,
} from '@shared/types';

import { usePointerDragResize } from '../../hooks/use-pointer-drag-resize';
import { cn } from '../../lib/utilities';
import { useSessionState } from '../../stores/selectors';
import { TERMINAL_DRAG_TYPE } from '../terminal/terminal-actions';
import type { EditorDragPayload, EditorDropZone } from './editor-drop-zone';
import {
    decodeEditorDragPayload,
    EDITOR_DRAG_TYPE,
    hasEditorDragType,
    resolveEditorDropZone,
} from './editor-drop-zone';
import {
    activateEditorTab,
    moveEditorTabToGroup,
    resizeEditorSplit,
    splitEditorTabTo,
} from './editor-layout-actions';
import { EditorSurface } from './editor-surface';

const fullBleedClassName = 'h-full w-full min-h-0 min-w-0';

/**
 * Matches the shared `editorLayoutSchema` ratio bounds enforced by `resizeSplit` in `editor-layout.ts`; kept local here
 * (like the identical constants in `terminal-layout-view.tsx`) since only the ratio-scale clamp is needed for the
 * drag/keyboard step, not the aria percent-scale one.
 */
const MIN_SPLIT_RATIO = 0.15;
const MAX_SPLIT_RATIO = 0.85;

const editorGroupClassName = cn('editor-group', fullBleedClassName, 'relative');

const editorDropPreviewClassName =
    'absolute z-[5] grid place-items-center border border-accent bg-[color-mix(in_srgb,var(--accent)_24%,transparent)] text-foreground text-[11px] pointer-events-none';

const dropZoneClassName: Record<EditorDropZone, string> = {
    center: 'inset-[18%]',
    left: 'inset-[0_50%_0_0]',
    right: 'inset-[0_0_0_50%]',
    up: 'inset-[0_0_50%_0]',
    down: 'inset-[50%_0_0_0]',
};

const dropZoneLabel: Record<EditorDropZone, string> = {
    center: 'Move to group',
    left: 'Split left',
    right: 'Split right',
    up: 'Split up',
    down: 'Split down',
};

function dropZoneFromEvent(event: DragEvent<HTMLElement>): EditorDropZone {
    const bounds = event.currentTarget.getBoundingClientRect();
    return resolveEditorDropZone(
        { width: bounds.width, height: bounds.height },
        { x: event.clientX - bounds.left, y: event.clientY - bounds.top },
    );
}

/**
 * Preview and accept only our custom Editor MIME type. `getData` is empty during `dragenter`/`dragover`, so those
 * handlers must use {@link hasEditorDragType}; `readEditorDragPayload` is for `drop`, where the path is readable.
 */
function isEditorDrag(event: DragEvent<HTMLElement>): boolean {
    // A Terminal tab drag must never be treated as an Editor drag just because both also set `text/plain`.
    return (
        !event.dataTransfer.types.includes(TERMINAL_DRAG_TYPE) &&
        hasEditorDragType(event.dataTransfer.types)
    );
}

function readEditorDragPayload(event: DragEvent<HTMLElement>): EditorDragPayload | undefined {
    if (!isEditorDrag(event)) return undefined;
    const raw =
        event.dataTransfer.getData(EDITOR_DRAG_TYPE) || event.dataTransfer.getData('text/plain');
    return decodeEditorDragPayload(raw);
}

interface NodeViewProperties {
    groupNumbers: Map<string, number>;
    layout: EditorLayout;
    node: EditorLayoutNode;
}

function groupNumbers(root?: EditorLayoutNode): Map<string, number> {
    const result = new Map<string, number>();
    const visit = (node?: EditorLayoutNode): void => {
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

function EditorGroupView(properties: NodeViewProperties & { node: EditorGroupNode }) {
    const [activeDropZone, setActiveDropZone] = useState<EditorDropZone>();
    const path = properties.node.activePath ?? properties.node.paths[0];
    if (!path) return null;
    const isActive = properties.layout.activeGroupId === properties.node.id;
    const applyDrop = (event: DragEvent<HTMLDivElement>): void => {
        event.preventDefault();
        const zone = dropZoneFromEvent(event);
        setActiveDropZone(undefined);
        const payload = readEditorDragPayload(event);
        if (!payload) return;
        if (zone === 'center') {
            // `moveEditorPath` needs an explicit source group (unlike Terminal moves) because the same path can be
            // open in several groups at once. The drag payload carries the group the drag actually started from;
            // `findPathGroupId` is only a fallback for payloads without one (e.g. a bare `text/plain` path).
            const sourceGroupId =
                payload.sourceGroupId ??
                findPathGroupId(properties.layout, payload.path) ??
                properties.node.id;
            moveEditorTabToGroup(payload.path, sourceGroupId, properties.node.id);
        } else {
            splitEditorTabTo(payload.path, properties.node.id, zone);
        }
    };
    const label = `Editor group ${properties.groupNumbers.get(properties.node.id) ?? 1}: ${path}`;
    return (
        <div
            className={cn(
                editorGroupClassName,
                isActive &&
                    'active shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--accent)_55%,transparent)]',
            )}
            aria-label={label}
            data-drop-zone={activeDropZone}
            data-group-id={properties.node.id}
            onDragEnter={(event) => {
                if (!isEditorDrag(event)) return;
                event.preventDefault();
                setActiveDropZone(dropZoneFromEvent(event));
            }}
            onDragLeave={(event) => {
                if (!event.currentTarget.contains(event.relatedTarget as Node | null))
                    setActiveDropZone(undefined);
            }}
            onDragOver={(event) => {
                if (!isEditorDrag(event)) return;
                event.preventDefault();
                event.dataTransfer.dropEffect = 'move';
                setActiveDropZone(dropZoneFromEvent(event));
            }}
            onDrop={applyDrop}
            onFocus={() => activateEditorTab(path, properties.node.id)}
        >
            <EditorSurface path={path} />
            {activeDropZone && (
                <div
                    className={cn(
                        `editor-drop-preview editor-drop-${activeDropZone}`,
                        editorDropPreviewClassName,
                        dropZoneClassName[activeDropZone],
                    )}
                >
                    {dropZoneLabel[activeDropZone]}
                </div>
            )}
        </div>
    );
}

function EditorSplitView(properties: NodeViewProperties & { node: EditorSplitNode }) {
    const [draftRatio, setDraftRatio] = useState<number>();
    const ratio = draftRatio ?? properties.node.ratio;
    const isHorizontal = properties.node.direction === 'horizontal';
    const dragResize = usePointerDragResize({
        value: ratio,
        min: MIN_SPLIT_RATIO,
        max: MAX_SPLIT_RATIO,
        resolveValue: (event) => {
            const container = event.currentTarget.parentElement;
            if (!container) return ratio;
            const bounds = container.getBoundingClientRect();
            return isHorizontal
                ? (event.clientX - bounds.left) / bounds.width
                : (event.clientY - bounds.top) / bounds.height;
        },
        onDragMove: (next) => setDraftRatio(next),
        onCommit: (next) => {
            setDraftRatio(undefined);
            resizeEditorSplit(properties.node.id, next);
        },
        onCancel: () => setDraftRatio(undefined),
        resolveStep: (event) => {
            const isDecrease = isHorizontal ? event.key === 'ArrowLeft' : event.key === 'ArrowUp';
            const isIncrease = isHorizontal
                ? event.key === 'ArrowRight'
                : event.key === 'ArrowDown';
            if (!isDecrease && !isIncrease) return;
            return isDecrease ? -0.05 : 0.05;
        },
    });
    const firstStyle = {
        flexBasis: `${ratio * 100}%`,
    } satisfies CSSProperties;
    return (
        <div
            className={cn(
                `editor-split editor-split-${properties.node.direction}`,
                fullBleedClassName,
                'flex',
                isHorizontal ? 'flex-row' : 'flex-col',
            )}
            data-split-id={properties.node.id}
        >
            <div
                className={cn('editor-layout-child', fullBleedClassName, 'flex-1')}
                style={firstStyle}
            >
                <EditorNodeView {...properties} node={properties.node.first} />
            </div>
            <div
                role="separator"
                tabIndex={0}
                className={cn(
                    'editor-splitter',
                    'relative z-[3] flex-none basis-1 border-0 bg-border',
                    'hover:bg-accent focus-visible:bg-accent focus-visible:outline-none',
                    isHorizontal ? 'cursor-col-resize' : 'cursor-row-resize',
                )}
                aria-label={`Resize ${isHorizontal ? 'horizontal' : 'vertical'} Editor split`}
                aria-orientation={isHorizontal ? 'vertical' : 'horizontal'}
                aria-valuemin={15}
                aria-valuemax={85}
                aria-valuenow={Math.round(ratio * 100)}
                onKeyDown={dragResize.onKeyDown}
                onPointerDown={dragResize.onPointerDown}
                onPointerMove={dragResize.onPointerMove}
                onPointerUp={dragResize.onPointerUp}
                onPointerCancel={dragResize.onPointerCancel}
                onLostPointerCapture={dragResize.onLostPointerCapture}
            />
            <div className={cn('editor-layout-child', fullBleedClassName, 'flex-1')}>
                <EditorNodeView {...properties} node={properties.node.second} />
            </div>
        </div>
    );
}

function EditorNodeView(properties: NodeViewProperties) {
    return properties.node.type === 'group' ? (
        <EditorGroupView {...properties} node={properties.node} />
    ) : (
        <EditorSplitView {...properties} node={properties.node} />
    );
}

/**
 * Renders the Editor center pane's split-layout tree. A Session with no split layout (or a single group) derives an
 * equivalent single-group tree via `sessionEditorLayout`, so this always renders the same content a bare
 * `<EditorSurface>` would show before Phase 4 — there is no separate "unsplit" rendering path to regress.
 */
export function EditorLayoutView() {
    const sessionState = useSessionState();
    const layout = useMemo(
        () => (sessionState ? sessionEditorLayout(sessionState) : undefined),
        [sessionState],
    );
    const numbers = useMemo(() => groupNumbers(layout?.root), [layout?.root]);
    if (!layout?.root) return null;
    return <EditorNodeView layout={layout} node={layout.root} groupNumbers={numbers} />;
}
