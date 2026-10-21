import type { CSSProperties, DragEvent } from 'react';
import { useRef, useState } from 'react';

import type { PaneLayout, PaneLayoutNode, PaneNode, PaneSplitNode } from '@caxri/protocol';
import {
    isChatTerminal,
    listPanes,
    listPaneTabs,
    listPaneTerminalIds,
    MAX_SPLIT_RATIO,
    MIN_SPLIT_RATIO,
} from '@caxri/protocol';
import { TerminalSquare } from 'lucide-react';

import { Empty, EmptyMedia, EmptyTitle } from '../../components/ui/empty';
import { usePointerDragResize } from '../../hooks/use-pointer-drag-resize';
import type { TranslationKey } from '../../i18n';
import { useTranslation } from '../../i18n';
import { hasTerminalDraggedPath } from '../../lib/file-drag';
import { cn } from '../../lib/utilities';
import { useSessionState, useTerminal } from '../../stores/selectors';
import { AgentChatTerminalContent } from '../agent-chat/tasks/agent-chat-terminal-content';
import { EditorSurface } from '../editor/editor-surface';
import { useIsSecondarySidebarShown } from '../secondary-sidebar/secondary-sidebar-visibility';
import { workPanelId, workTabId } from '../tabs/work-tab-accessibility';
import { NewTerminalButton } from '../terminal/new-terminal-button';
import { didPasteDropIntoTerminal } from '../terminal/terminal-drop';
import { TerminalPane } from '../terminal/terminal-pane';
import { focusPane, movePaneTab, resizePaneSplit, splitPaneTab } from './pane-actions';
import type { PaneDropZone } from './pane-drop-zone';
import { PANE_TAB_DRAG_TYPE, resolvePaneDropIntent, resolvePaneDropZone } from './pane-drop-zone';
import { PaneMountPortal } from './pane-mount-portal';
import { reconcilePaneMounts } from './pane-mounts';
import { PaneTabBar } from './pane-tab-bar';
import { PaneViewLayoutSignalProvider } from './pane-view-layout-signal';
import { PaneViewSessionProvider, usePaneViewSession } from './pane-view-session';
import { useTabFocusRecovery } from './use-tab-focus-recovery';

const fullBleedClassName = 'h-full w-full min-h-0 min-w-0';

/**
 * The preview element stays mounted while the pointer moves between zones, so its insets glide from one half to the
 * next instead of jumping, the way VS Code's editor drop overlay tracks a dragged tab; that motion shows which split
 * the drop will create. It fades in once when the drag first enters the pane.
 */
const dropPreviewClassName =
    'absolute z-[5] grid place-items-center border border-accent bg-[color-mix(in_srgb,var(--accent)_24%,transparent)] text-foreground text-[11px] pointer-events-none transition-[top,right,bottom,left] duration-(--motion-chrome-switch) ease-(--motion-ease-emphasized) motion-reduce:transition-none motion-safe:animate-in motion-safe:fade-in-0';

const dropZoneClassName: Record<PaneDropZone, string> = {
    center: 'inset-[18%]',
    left: 'inset-[0_50%_0_0]',
    right: 'inset-[0_0_0_50%]',
    up: 'inset-[0_0_50%_0]',
    down: 'inset-[50%_0_0_0]',
};

const dropZoneLabelKeys: Record<PaneDropZone, TranslationKey> = {
    center: 'workbench.pane.dropZone.center',
    left: 'workbench.pane.dropZone.left',
    right: 'workbench.pane.dropZone.right',
    up: 'workbench.pane.dropZone.up',
    down: 'workbench.pane.dropZone.down',
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

/**
 * Whether the leading pane's tab bar reaches the window's right edge. It does until a side-by-side split puts another
 * pane beside it, after which the bar is only as wide as its own pane and anything it reserves at its trailing end (the
 * drag corner) lands in the middle of the window instead of in the corner, wedged between the "+" button and the
 * neighbouring pane's first tab. An open SecondarySidebar ends the bar at that rail the same way, whatever the split.
 */
function isLeadingBarWindowWide(node: PaneLayoutNode): boolean {
    if (node.type === 'pane') return true;
    return node.direction !== 'horizontal' && isLeadingBarWindowWide(node.first);
}

function EmptyPane() {
    const { t } = useTranslation();
    return (
        <Empty className="empty-work h-full flex-1">
            <EmptyMedia>
                <TerminalSquare size={30} />
            </EmptyMedia>
            <EmptyTitle>{t('workbench.pane.empty')}</EmptyTitle>
            <NewTerminalButton appearance="labelled" />
        </Empty>
    );
}

/**
 * The active tab's content. A Terminal and a document reach the same slot through the same path; the tab's kind decides
 * only which component renders here, never how the pane behaves.
 */
function PaneContent({
    isActivePane,
    isVisible,
    pane,
}: {
    isActivePane: boolean;
    isVisible: boolean;
    pane: PaneNode;
}) {
    const tab = pane.tabs.find((candidate) => candidate.id === pane.activeTabId) ?? pane.tabs.at(0);
    const terminalId = tab?.resource.kind === 'terminal' ? tab.resource.terminalId : undefined;
    const terminal = useTerminal(terminalId ?? '');
    if (!tab) return <EmptyPane />;
    if (tab.resource.kind === 'terminal') {
        if (!terminal) return null;
        if (isChatTerminal(terminal))
            return (
                <AgentChatTerminalContent
                    isSessionVisible={isVisible}
                    isShown={isActivePane && isVisible}
                    key={terminal.id}
                    terminal={terminal}
                />
            );
        return (
            <TerminalPane
                active={isActivePane}
                ariaLabel={terminal.title}
                isPaneVisible={isVisible}
                terminalId={terminal.id}
            />
        );
    }
    return <EditorSurface paneId={pane.id} path={tab.resource.path} />;
}

function PaneBox({
    isLeading,
    isVisible,
    layout,
    pane,
    spansWindowWidth,
}: {
    isLeading: boolean;
    isVisible: boolean;
    layout: PaneLayout;
    pane: PaneNode;
    spansWindowWidth: boolean;
}) {
    const { t } = useTranslation();
    const [activeDropZone, setActiveDropZone] = useState<PaneDropZone>();
    const isActivePane = layout.activePaneId === pane.id;
    /**
     * Whether the focus about to arrive is the default action of a pointer press, which the tab's own `onClick` will
     * finish. Focus reaching a tab any other way (`Tab` traversal, a cancelled drag, the focus recovery below) has no
     * click behind it, so only the pointer case may leave the pane activation to the click.
     */
    const isPointerPressed = useRef(false);
    /**
     * The other half of that deferral: a press that never becomes a click leaves nobody to run `selectTab`. A drag
     * cancelled with `Escape` is the everyday case (`pointerdown → focusin → dragstart → dragend`, no `click`) and it
     * would otherwise strand focus in one pane while `activePaneId`, the focus ring, the Status Bar, and every
     * layout-resolved command stay on another.
     *
     * Checked a frame after the interaction ends so an ordinary click's own selection lands first; `focusPane` no-ops
     * on an already-active pane, so this costs nothing whenever the click did arrive.
     */
    const settlePaneActivation = (root: HTMLElement): void => {
        requestAnimationFrame(() => {
            if (root.contains(document.activeElement)) focusPane(pane.id);
        });
    };
    const activeTab =
        pane.tabs.find((candidate) => candidate.id === pane.activeTabId) ?? pane.tabs.at(0);
    const terminalId =
        activeTab?.resource.kind === 'terminal' ? activeTab.resource.terminalId : undefined;
    const terminal = useTerminal(terminalId ?? '');
    const session = usePaneViewSession();
    /**
     * A file dragged from the Files panel onto a Terminal pastes its path; onto a document pane it means nothing, so
     * only a live Terminal accepts it.
     */
    const isAcceptsFileDrop =
        terminal !== undefined &&
        !isChatTerminal(terminal) &&
        terminal.lastProcessState === 'running';
    // A stable, tree-order name so a screen reader can tell each pane's tablist apart; `aria-label="Open tabs"`
    // repeated on every pane left them indistinguishable once a Workbench held more than one. The total is part of the
    // name because an ordinal alone ("pane 2") gives no sense of how far the split tree extends.
    const panes = listPanes(layout);
    const tabListLabel = t('workbench.pane.tabListLabel', {
        index: panes.findIndex((candidate) => candidate.id === pane.id) + 1,
        count: panes.length,
    });
    // Session-wide, not pane-local: a Terminal moved to a new session leaves its Session behind entirely, so the guard
    // must see every pane's Terminals, not just the ones sharing this Terminal's own tab bar.
    const isOnlySessionTerminal = listPaneTerminalIds(layout).length === 1;
    // Workbench-wide for the same reason the tab bar's chrome is: a second tab in *any* pane is something to switch to,
    // so a split whose panes each hold one tab still needs the active accent and the "New Terminal" button.
    const hasTabsToSwitch = listPaneTabs(layout).length > 1;
    const dropIntent = (event: DragEvent<HTMLElement>) =>
        resolvePaneDropIntent(event.dataTransfer.types, {
            altKey: event.altKey,
            isTerminal: Boolean(terminalId),
            acceptsFileDrop: isAcceptsFileDrop,
            hasFilePath: hasTerminalDraggedPath(event),
        });
    const canPreviewDrop = (event: DragEvent<HTMLElement>): boolean => {
        const intent = dropIntent(event);
        if (!intent) {
            setActiveDropZone(undefined);
            return false;
        }
        event.preventDefault();
        event.dataTransfer.dropEffect = intent === 'place' ? 'move' : 'copy';
        setActiveDropZone(intent === 'place' ? dropZoneFromEvent(event) : undefined);
        return true;
    };
    const applyDrop = (event: DragEvent<HTMLDivElement>): void => {
        const zone = dropZoneFromEvent(event);
        setActiveDropZone(undefined);
        const intent = dropIntent(event);
        if (!intent) return;
        if (intent === 'paste') {
            if (terminal && didPasteDropIntoTerminal(event, terminal, session?.rootPath))
                focusPane(pane.id);
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
            onPointerDownCapture={() => {
                isPointerPressed.current = true;
                // Focus is dispatched as the pointer press's default action, synchronously before this frame ends, so
                // clearing on the next frame cannot swallow it and cannot leak into a press that never became a click.
                requestAnimationFrame(() => {
                    isPointerPressed.current = false;
                });
            }}
            onFocusCapture={(event) => {
                /**
                 * Clicking a tab in an inactive pane focuses the tab first and selects it after, and `selectTab`
                 * already moves `activePaneId` onto the tab's own pane. Activating the pane from here as well wrote the
                 * entire SessionState twice for one click, two independent `session.updateState` round-trips, so a
                 * pointer-driven focus that lands on a tab is left for the tab's own selection to finish.
                 *
                 * Every other way into a tab is a real focus change with no click behind it: each pane's active tab is
                 * `tabIndex=0`, so `Tab` traversal alone can move focus into another pane, and leaving `activePaneId`
                 * behind would point the focus ring, the Status Bar, and every layout-resolved command at the pane the
                 * user just left.
                 */
                if (
                    isPointerPressed.current &&
                    event.target instanceof Element &&
                    event.target.closest('[data-pane-tab-id]')
                )
                    return;
                focusPane(pane.id);
            }}
            onPointerUpCapture={(event) => settlePaneActivation(event.currentTarget)}
            onDragEnd={(event) => settlePaneActivation(event.currentTarget)}
        >
            <PaneTabBar
                key={pane.id}
                hasTabsToSwitch={hasTabsToSwitch}
                isOnlySessionTerminal={isOnlySessionTerminal}
                isRootBar={isLeading}
                pane={pane}
                tabListLabel={tabListLabel}
                spansWindowWidth={spansWindowWidth}
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
                <PaneContent isActivePane={isActivePane} isVisible={isVisible} pane={pane} />
                {activeDropZone && (
                    <div
                        className={cn(
                            `pane-drop-preview pane-drop-${activeDropZone}`,
                            dropPreviewClassName,
                            dropZoneClassName[activeDropZone],
                        )}
                    >
                        {t(dropZoneLabelKeys[activeDropZone])}
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
    const { t } = useTranslation();
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
    /**
     * Both children share the remaining space by `flex-grow` from a zero basis, so the splitter lands at exactly
     * `ratio` of the container. Setting `flexBasis: ratio%` on the first child while both kept `flex-1` left the
     * leftover space split evenly, which put the splitter at `(1 + ratio) / 2` instead: a pointer-driven ratio (which
     * resolves the absolute pointer position) then overshot on every move, so the splitter jumped away from the pointer
     * at drag start and tracked it at half speed afterwards.
     */
    const firstStyle = { flex: `${ratio} 1 0%` } satisfies CSSProperties;
    const secondStyle = { flex: `${1 - ratio} 1 0%` } satisfies CSSProperties;
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
            <div className={cn('pane-split-child', fullBleedClassName)} style={firstStyle}>
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
                aria-label={t(
                    isHorizontal
                        ? 'workbench.pane.resizeHorizontalSplit'
                        : 'workbench.pane.resizeVerticalSplit',
                )}
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
            <div className={cn('pane-split-child', fullBleedClassName)} style={secondStyle}>
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
        <div className={fullBleedClassName} data-pane-slot={node.id} />
    ) : (
        <PaneSplitView leadingPane={leadingPane} layout={layout} node={node} />
    );
}

/**
 * One Session's split tree. Terminals and documents live in the same panes and obey the same layout rules; nothing
 * above this component branches on what a tab holds.
 *
 * Several of these are mounted at once, one per Session the Workbench keeps alive, so it takes its Session by id rather
 * than reading the selection. `isVisible` marks the one on screen; the others stay mounted with their xterm buffers,
 * Editor models, and scroll positions intact, which is what makes switching back a redraw instead of a rebuild (issue
 * #657).
 */
export function PaneView({ isVisible, sessionId }: { isVisible: boolean; sessionId: string }) {
    const layout = useSessionState(sessionId)?.paneLayout;
    const [mounted, setMounted] = useState(() => ({
        layout,
        panes: reconcilePaneMounts([], layout ? listPanes(layout) : []),
    }));
    let panes = mounted.panes;
    if (mounted.layout !== layout) {
        panes = reconcilePaneMounts(panes, layout ? listPanes(layout) : []);
        setMounted({ layout, panes });
    }
    useTabFocusRecovery(layout, isVisible);
    const isSecondarySidebarVisible = useIsSecondarySidebarShown();
    if (!layout) return null;
    return (
        <PaneViewSessionProvider value={sessionId}>
            <PaneViewLayoutSignalProvider value={layout}>
                <div className={fullBleedClassName}>
                    <PaneNodeView
                        leadingPane={leadingPaneId(layout.root)}
                        layout={layout}
                        node={layout.root}
                    />
                    {panes.map(({ key, pane }) => (
                        <PaneMountPortal key={key} paneId={pane.id}>
                            <PaneBox
                                isLeading={pane.id === leadingPaneId(layout.root)}
                                isVisible={isVisible}
                                layout={layout}
                                pane={pane}
                                spansWindowWidth={
                                    !isSecondarySidebarVisible &&
                                    isLeadingBarWindowWide(layout.root)
                                }
                            />
                        </PaneMountPortal>
                    ))}
                </div>
            </PaneViewLayoutSignalProvider>
        </PaneViewSessionProvider>
    );
}
