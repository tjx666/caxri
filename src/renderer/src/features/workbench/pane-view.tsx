import type { CSSProperties, DragEvent } from 'react';
import { useEffect, useState } from 'react';

import { MAX_SPLIT_RATIO, MIN_SPLIT_RATIO } from '@shared/ipc/pane-layout';
import { listPanes, listPaneTerminalIds } from '@shared/pane-layout';
import type { PaneLayout, PaneLayoutNode, PaneNode, PaneSplitNode } from '@shared/types';
import { TerminalSquare } from 'lucide-react';

import { Button } from '../../components/ui/button';
import { Empty, EmptyMedia, EmptyTitle } from '../../components/ui/empty';
import { usePointerDragResize } from '../../hooks/use-pointer-drag-resize';
import { dragPath, hasDraggedPath, terminalInputPath } from '../../lib/file-drag';
import { cn } from '../../lib/utilities';
import { useSessionState, useTerminal } from '../../stores/selectors';
import { EditorSurface } from '../editor/editor-surface';
import { workPanelId, workTabId } from '../tabs/work-tab-accessibility';
import { createTerminal, didPasteIntoTerminal } from '../terminal/terminal-actions';
import { TerminalPane } from '../terminal/terminal-pane';
import { retainTerminalProgress } from '../terminal/terminal-progress';
import { focusPane, movePaneTab, resizePaneSplit, splitPaneTab } from './pane-actions';
import type { PaneDropZone } from './pane-drop-zone';
import { hasPaneTabDragType, PANE_TAB_DRAG_TYPE, resolvePaneDropZone } from './pane-drop-zone';
import { PaneTabBar } from './pane-tab-bar';

const fullBleedClassName = 'h-full w-full min-h-0 min-w-0';

const dropPreviewClassName =
    'absolute z-[5] grid place-items-center border border-accent bg-[color-mix(in_srgb,var(--accent)_24%,transparent)] text-foreground text-[11px] pointer-events-none';

const dropZoneClassName: Record<PaneDropZone, string> = {
    center: 'inset-[18%]',
    left: 'inset-[0_50%_0_0]',
    right: 'inset-[0_0_0_50%]',
    up: 'inset-[0_0_50%_0]',
    down: 'inset-[50%_0_0_0]',
};

const dropZoneLabel: Record<PaneDropZone, string> = {
    center: 'Move to pane',
    left: 'Split left',
    right: 'Split right',
    up: 'Split up',
    down: 'Split down',
};

function dropZoneFromEvent(event: DragEvent<HTMLElement>): PaneDropZone {
    const bounds = event.currentTarget.getBoundingClientRect();
    return resolvePaneDropZone(
        { width: bounds.width, height: bounds.height },
        { x: event.clientX - bounds.left, y: event.clientY - bounds.top },
    );
}

/**
 * The pane whose bar owns the frameless window's drag region and the traffic-light inset: the top-left leaf, which is
 * the only bar guaranteed to touch the window's title area.
 */
function leadingPaneId(node: PaneLayoutNode): string {
    return node.type === 'pane' ? node.id : leadingPaneId(node.first);
}

function EmptyPane() {
    return (
        <Empty className="empty-work h-full flex-1">
            <EmptyMedia>
                <TerminalSquare size={30} />
            </EmptyMedia>
            <EmptyTitle>No Terminal in this Session.</EmptyTitle>
            <Button
                onClick={() => {
                    // eslint-disable-next-line no-void -- intentional floating-promise discard, createTerminal() reports its own errors via tryCommand
                    void createTerminal('shell');
                }}
            >
                New Terminal
            </Button>
        </Empty>
    );
}

/**
 * The active tab's content. A Terminal and a document reach the same slot through the same path; the tab's kind decides
 * only which component renders here, never how the pane behaves.
 */
function PaneContent({ isActivePane, pane }: { isActivePane: boolean; pane: PaneNode }) {
    const tab = pane.tabs.find((candidate) => candidate.id === pane.activeTabId) ?? pane.tabs.at(0);
    const terminalId = tab?.resource.kind === 'terminal' ? tab.resource.terminalId : undefined;
    const terminal = useTerminal(terminalId ?? '');
    if (!tab) return <EmptyPane />;
    if (tab.resource.kind === 'terminal')
        return terminal ? (
            <TerminalPane
                active={isActivePane}
                ariaLabel={terminal.title}
                terminalId={terminal.id}
            />
        ) : null;
    return <EditorSurface path={tab.resource.path} />;
}

function PaneBox({
    isLeading,
    layout,
    pane,
}: {
    isLeading: boolean;
    layout: PaneLayout;
    pane: PaneNode;
}) {
    const [activeDropZone, setActiveDropZone] = useState<PaneDropZone>();
    const isActivePane = layout.activePaneId === pane.id;
    const activeTab =
        pane.tabs.find((candidate) => candidate.id === pane.activeTabId) ?? pane.tabs.at(0);
    const terminalId =
        activeTab?.resource.kind === 'terminal' ? activeTab.resource.terminalId : undefined;
    const terminal = useTerminal(terminalId ?? '');
    /**
     * A file dragged from the Files panel onto a Terminal pastes its path; onto a document pane it means nothing, so
     * only a live Terminal accepts it.
     */
    const isAcceptsFileDrop = Boolean(terminal) && terminal?.lastProcessState === 'running';
    // A stable, tree-order name so a screen reader can tell each pane's tablist apart; `aria-label="Open tabs"`
    // repeated on every pane left them indistinguishable once a Workbench held more than one.
    const paneLabel = `pane ${listPanes(layout).findIndex((candidate) => candidate.id === pane.id) + 1}`;
    // Session-wide, not pane-local: a Terminal moved to a new session leaves its Session behind entirely, so the guard
    // must see every pane's Terminals, not just the ones sharing this Terminal's own tab bar.
    const isOnlySessionTerminal = listPaneTerminalIds(layout).length === 1;
    const canPreviewDrop = (event: DragEvent<HTMLElement>): boolean => {
        const isTabDrag = hasPaneTabDragType(event.dataTransfer.types);
        if (!isTabDrag && !(isAcceptsFileDrop && hasDraggedPath(event))) return false;
        event.preventDefault();
        event.dataTransfer.dropEffect = isTabDrag ? 'move' : 'copy';
        setActiveDropZone(isTabDrag ? dropZoneFromEvent(event) : undefined);
        return true;
    };
    const applyDrop = (event: DragEvent<HTMLDivElement>): void => {
        const zone = dropZoneFromEvent(event);
        setActiveDropZone(undefined);
        const path = dragPath(event);
        if (path) {
            if (!terminal || !isAcceptsFileDrop) return;
            event.preventDefault();
            if (didPasteIntoTerminal(terminal.id, terminalInputPath(path))) focusPane(pane.id);
            return;
        }
        const tabId = event.dataTransfer.getData(PANE_TAB_DRAG_TYPE);
        if (!tabId) return;
        event.preventDefault();
        if (zone === 'center') movePaneTab(tabId, pane.id);
        else splitPaneTab(tabId, pane.id, zone);
    };
    return (
        <div
            className={cn(
                'workbench-pane flex flex-col bg-background',
                fullBleedClassName,
                isActivePane &&
                    'active shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--accent)_55%,transparent)]',
            )}
            data-pane-id={pane.id}
            onFocusCapture={() => focusPane(pane.id)}
        >
            <PaneTabBar
                isOnlySessionTerminal={isOnlySessionTerminal}
                isRootBar={isLeading}
                pane={pane}
                paneLabel={paneLabel}
            />
            <div
                className="pane-surface relative min-h-0 flex-1"
                data-drop-zone={activeDropZone}
                {...(activeTab && {
                    'aria-labelledby': workTabId(activeTab.id),
                    'id': workPanelId(activeTab.id),
                    'role': 'tabpanel',
                })}
                onDragEnter={(event) => canPreviewDrop(event)}
                onDragLeave={(event) => {
                    if (!event.currentTarget.contains(event.relatedTarget as Node | null))
                        setActiveDropZone(undefined);
                }}
                onDragOver={(event) => canPreviewDrop(event)}
                onDrop={applyDrop}
            >
                <PaneContent isActivePane={isActivePane} pane={pane} />
                {activeDropZone && (
                    <div
                        className={cn(
                            `pane-drop-preview pane-drop-${activeDropZone}`,
                            dropPreviewClassName,
                            dropZoneClassName[activeDropZone],
                        )}
                    >
                        {dropZoneLabel[activeDropZone]}
                    </div>
                )}
            </div>
        </div>
    );
}

function PaneSplitView({
    leadingPane,
    layout,
    node,
}: {
    leadingPane: string;
    layout: PaneLayout;
    node: PaneSplitNode;
}) {
    const [draftRatio, setDraftRatio] = useState<number>();
    const ratio = draftRatio ?? node.ratio;
    const isHorizontal = node.direction === 'horizontal';
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
            resizePaneSplit(node.id, next);
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
    const firstStyle = { flexBasis: `${ratio * 100}%` } satisfies CSSProperties;
    return (
        <div
            className={cn(
                `pane-split pane-split-${node.direction}`,
                fullBleedClassName,
                'flex',
                isHorizontal ? 'flex-row' : 'flex-col',
            )}
            data-split-id={node.id}
        >
            <div
                className={cn('pane-split-child', fullBleedClassName, 'flex-1')}
                style={firstStyle}
            >
                <PaneNodeView leadingPane={leadingPane} layout={layout} node={node.first} />
            </div>
            <div
                role="separator"
                tabIndex={0}
                className={cn(
                    'pane-splitter relative z-[3] flex-none basis-1 border-0 bg-border',
                    'hover:bg-accent focus-visible:bg-accent focus-visible:outline-none',
                    isHorizontal ? 'cursor-col-resize' : 'cursor-row-resize',
                )}
                aria-label={`Resize ${isHorizontal ? 'horizontal' : 'vertical'} split`}
                aria-orientation={isHorizontal ? 'vertical' : 'horizontal'}
                aria-valuemin={Math.round(MIN_SPLIT_RATIO * 100)}
                aria-valuemax={Math.round(MAX_SPLIT_RATIO * 100)}
                aria-valuenow={Math.round(ratio * 100)}
                onKeyDown={dragResize.onKeyDown}
                onPointerDown={dragResize.onPointerDown}
                onPointerMove={dragResize.onPointerMove}
                onPointerUp={dragResize.onPointerUp}
                onPointerCancel={dragResize.onPointerCancel}
                onLostPointerCapture={dragResize.onLostPointerCapture}
            />
            <div className={cn('pane-split-child', fullBleedClassName, 'flex-1')}>
                <PaneNodeView leadingPane={leadingPane} layout={layout} node={node.second} />
            </div>
        </div>
    );
}

function PaneNodeView({
    leadingPane,
    layout,
    node,
}: {
    leadingPane: string;
    layout: PaneLayout;
    node: PaneLayoutNode;
}) {
    return node.type === 'pane' ? (
        <PaneBox isLeading={node.id === leadingPane} layout={layout} pane={node} />
    ) : (
        <PaneSplitView leadingPane={leadingPane} layout={layout} node={node} />
    );
}

/**
 * The Workbench's single split tree. Terminals and documents live in the same panes and obey the same layout rules;
 * nothing above this component branches on what a tab holds.
 */
export function PaneView() {
    const layout = useSessionState()?.paneLayout;
    /**
     * Retained once for the whole layout, not per pane: `retainTerminalProgress` drops every Terminal outside the set
     * it is given, so calling it from each `PaneTabBar` with only that pane's Terminals would have panes clearing each
     * other's progress badges every time any of them re-ran the effect.
     */
    const terminalKey = layout ? listPaneTerminalIds(layout).join('\u{0}') : '';
    useEffect(() => {
        retainTerminalProgress(new Set(terminalKey ? terminalKey.split('\u{0}') : []));
    }, [terminalKey]);
    if (!layout) return null;
    return (
        <PaneNodeView leadingPane={leadingPaneId(layout.root)} layout={layout} node={layout.root} />
    );
}
