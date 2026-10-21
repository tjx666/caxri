import type { ReactNode, RefObject } from 'react';
import { useRef, useState } from 'react';

import type { PaneNode, PaneTab, TerminalRecord } from '@caxri/protocol';
import { partitionPaneTabs } from '@caxri/protocol';
import { AnimatePresence, domAnimation, LazyMotion } from 'motion/react';

import type { ScrollFadeFill } from '../../components/scroll-fade';
import { ScrollFade } from '../../components/scroll-fade';
import { useScrollEdges } from '../../hooks/use-scroll-edges';
import { cn } from '../../lib/utilities';
import { useChromeLayoutStore } from '../../stores/chrome-layout';
import { useIsSessionTabStripVisible } from '../../stores/open-sessions';
import { useIsFullScreen, useSessionState, useTerminal } from '../../stores/selectors';
import { editorTabActionsPath } from '../editor/document-tab-path-actions';
import type { WorkTabNavigationKey } from '../tabs/work-tab-accessibility';
import { workTabId, workTabNavigationTarget } from '../tabs/work-tab-accessibility';
import { canSwitchTerminalSurface } from '../terminal/terminal-surface-commands';
import { DocumentPaneTab } from './document-pane-tab';
import { selectPaneTab } from './pane-actions';
import { PaneTabActions } from './pane-tab-actions';
import { useActiveTabReveal } from './pane-tab-reveal';
import { usePaneViewSessionId } from './pane-view-session';
import type { PaneTabProperties } from './terminal-pane-tab';
import { TerminalPaneTab } from './terminal-pane-tab';
import { usePaneTabDrag } from './use-pane-tab-drag';

function PaneTabEntry(properties: PaneTabProperties & { isOnlySessionTerminal: boolean }) {
    const terminalId =
        properties.tab.resource.kind === 'terminal'
            ? properties.tab.resource.terminalId
            : undefined;
    const liveTerminal = useTerminal(terminalId ?? '');
    /**
     * `AnimatePresence` keeps this component mounted through its exit transition after `tab` drops out of the pane, but
     * a Terminal close removes the record `useTerminal` reads in that same store update: without this snapshot the exit
     * render sees `terminal === undefined` and bails to `null` one commit into the transition, unmounting `WorkTab`
     * before it ever renders `aria-hidden`/plays its exit animation. This follows React's documented "adjusting state
     * during render" pattern (https://react.dev/reference/react/useState#storing-information-from-previous-renders)
     * instead of a ref, since this repo's lint config forbids reading `ref.current` during render.
     */
    const [lastKnownTerminal, setLastKnownTerminal] = useState<TerminalRecord | undefined>(
        liveTerminal,
    );
    if (liveTerminal && liveTerminal !== lastKnownTerminal) setLastKnownTerminal(liveTerminal);
    const terminal = liveTerminal ?? lastKnownTerminal;
    if (properties.tab.resource.kind === 'terminal')
        return terminal ? <TerminalPaneTab {...properties} terminal={terminal} /> : null;
    return <DocumentPaneTab {...properties} path={properties.tab.resource.path} />;
}

/**
 * Moves roving tab focus one step through `tabs` and selects whatever it lands on, leaving focus where it was when the
 * key has no target: the ends of the rail for `ArrowLeft`/`ArrowRight`.
 */
function navigatePaneTabs(
    tabs: readonly PaneTab[],
    fromTabId: string,
    key: WorkTabNavigationKey,
): void {
    const target = workTabNavigationTarget(
        tabs.map((tab) => tab.id),
        fromTabId,
        key,
    );
    if (!target) return;
    const targetTab = document.querySelector<HTMLElement>(`#${CSS.escape(workTabId(target))}`);
    /**
     * Terminal activation normally moves focus into xterm. The marker exists for activations that must not take the
     * keyboard (roving tab navigation here, drag hover previews in `previewTab`) and is removed on blur, so the
     * Terminal process effect can preserve the WAI-ARIA tab focus without changing mouse selection behavior.
     */
    if (targetTab) {
        const tab = tabs.find((candidate) => candidate.id === target);
        if (tab?.resource.kind === 'terminal') targetTab.dataset.preserveTerminalFocus = 'true';
        targetTab.focus();
    }
    selectPaneTab(target);
}

/**
 * The two containers the bar lays out, the anchored Terminal segment and the scrolling document rail, plus the visual
 * order both of them are navigated in. Resolved here rather than inline so `PaneTabBar` reads as layout.
 */
function paneTabSegments(tabs: readonly PaneTab[]): {
    anchoredTabs: PaneTab[];
    orderedTabs: PaneTab[];
    railTabs: PaneTab[];
} {
    /**
     * Read off the tabs rather than off their index in `pane.tabs`: `orderPaneTabs` already keeps the stored order in
     * segments, and reading the segments here as well is what makes a layout persisted before they existed render
     * correctly instead of interleaving.
     */
    const { scrolling: railTabs, sticky: anchoredTabs } = partitionPaneTabs(tabs);
    // Visual order, which is what roving arrow-key focus has to walk.
    return { anchoredTabs, orderedTabs: [...anchoredTabs, ...railTabs], railTabs };
}

/**
 * One segment's tabs, under their own presence group. A tab's segment follows from its resource kind alone, so a tab
 * never moves between the two groups: a Terminal that changed container mid-life would animate out of the one it left
 * while already mounted in the one it joined, putting the same tab on the bar twice for the length of that animation.
 */
function PaneTabSegment({
    activeTabId,
    closable,
    isOnlySessionTerminal,
    navigationTabs,
    onExitComplete,
    paneId,
    separatorAfterLast,
    showActiveAccent,
    tabs,
}: {
    activeTabId: string | undefined;
    closable: boolean;
    isOnlySessionTerminal: boolean;
    /**
     * Visual order across both segments, so arrow keys walk the bar rather than the segment.
     */
    navigationTabs: readonly PaneTab[];
    onExitComplete: () => void;
    paneId: string;
    separatorAfterLast: boolean;
    showActiveAccent: boolean;
    tabs: readonly PaneTab[];
}) {
    return (
        <LazyMotion strict features={domAnimation}>
            <AnimatePresence initial={false} onExitComplete={onExitComplete}>
                {tabs.map((tab, index) => (
                    <PaneTabEntry
                        key={tab.id}
                        active={tab.id === activeTabId}
                        closable={closable}
                        isOnlySessionTerminal={isOnlySessionTerminal}
                        onNavigate={(key) => navigatePaneTabs(navigationTabs, tab.id, key)}
                        paneId={paneId}
                        showActiveAccent={showActiveAccent}
                        showTrailingSeparator={separatorAfterLast || index < tabs.length - 1}
                        tab={tab}
                    />
                ))}
            </AnimatePresence>
        </LazyMotion>
    );
}

/**
 * Whether a segment still owns width on the bar, and the `AnimatePresence` callback that ends it. Occupancy outlives
 * the segment's last tab on purpose: the commit that empties the segment is the same one that starts that tab's exit
 * animation, so collapsing on tab count alone would clip the tab away mid-flight and hand its width to the other
 * segment a beat early. An empty segment is hidden rather than unmounted: its rail is what the tab-bar specs and the
 * stylesheet's scrollbar rules address, and it has to survive a pane that is holding only the other kind.
 */
function useSegmentOccupancy(tabs: readonly PaneTab[]): {
    isOccupied: boolean;
    onExitComplete: () => void;
} {
    const [emptied, setEmptied] = useState(tabs.length === 0);
    if (emptied && tabs.length > 0) setEmptied(false);
    return {
        isOccupied: tabs.length > 0 || !emptied,
        onExitComplete: () => {
            if (tabs.length === 0) setEmptied(true);
        },
    };
}

/**
 * The scrolling half of one segment: the rail its tabs sit on, the two zero-width sentinels `useScrollEdges` watches,
 * and the gradient fade shown on whichever edge is actually hiding a tab. `overflow-x-auto` gives no cue of its own
 * that there is more to either side, and both segments can overflow (the documents routinely, the Terminals once enough
 * of them share the anchored half), so each gets its own rather than the bar cueing only one of them.
 */
function PaneTabScrollRail({
    children,
    className,
    fill,
    scrollClassName,
}: {
    children: ReactNode;
    className: string;
    fill: ScrollFadeFill;
    /**
     * `work-tab-scroll` or `work-tab-sticky`: which rail the stylesheet's quiet scrollbar rules apply to.
     */
    scrollClassName: string;
}) {
    const scrollReference = useRef<HTMLDivElement>(null);
    const startSentinel = useRef<HTMLSpanElement>(null);
    const endSentinel = useRef<HTMLSpanElement>(null);
    const { canScrollEnd, canScrollStart } = useScrollEdges(
        scrollReference,
        startSentinel,
        endSentinel,
    );
    return (
        <div role="none" className={cn('relative flex', className)}>
            <div
                ref={scrollReference}
                /**
                 * Marks the element that actually scrolls, so `useActiveTabReveal` can measure the active tab against
                 * its own rail: the tab's offset parent is the inner flex list, and either segment can be the one
                 * holding it.
                 */
                data-tab-scroll-rail=""
                className={cn('relative flex min-w-0 flex-1 overflow-x-auto', scrollClassName)}
            >
                <div
                    /**
                     * `min-w-full` (not `w-full`) lets evenly divided tabs claim the whole rail while still allowing
                     * the list to grow past it once enough tabs hit their minimum width, which is what hands overflow
                     * back to the scroll container above.
                     */
                    role="none"
                    className="work-tab-list flex h-9 min-w-full items-stretch"
                >
                    <span
                        ref={startSentinel}
                        aria-hidden="true"
                        className="w-px flex-none self-stretch"
                    />
                    {children}
                    <span
                        ref={endSentinel}
                        aria-hidden="true"
                        className="w-px flex-none self-stretch"
                    />
                </div>
            </div>
            {canScrollStart && <ScrollFade edge="start" fill={fill} />}
            {canScrollEnd && <ScrollFade edge="end" fill={fill} />}
        </div>
    );
}

/**
 * The tablist itself: the anchored Terminal segment, the scrolling document rail beside it, and the insertion line a
 * drag draws across both. Both containers stay mounted for the pane's whole life (which of the two a tab belongs to is
 * fixed by its resource kind), so the only thing that changes as tabs come and go is how the width is split.
 */
function PaneTabList({
    activeTabId,
    anchoredTabs,
    closable,
    dropIndicatorLeft,
    isDropTarget,
    isOnlySessionTerminal,
    isRootBar,
    listReference,
    orderedTabs,
    paneId,
    tabListLabel,
    railTabs,
    showActiveAccent,
}: {
    activeTabId: string | undefined;
    anchoredTabs: readonly PaneTab[];
    closable: boolean;
    dropIndicatorLeft: number | undefined;
    isDropTarget: boolean;
    isOnlySessionTerminal: boolean;
    isRootBar: boolean;
    listReference: RefObject<HTMLDivElement | null>;
    orderedTabs: readonly PaneTab[];
    paneId: string;
    tabListLabel: string;
    railTabs: readonly PaneTab[];
    showActiveAccent: boolean;
}) {
    const anchor = useSegmentOccupancy(anchoredTabs);
    const rail = useSegmentOccupancy(railTabs);
    const scrollFadeFill: ScrollFadeFill = isDropTarget
        ? 'dropTarget'
        : isRootBar
          ? 'titleBar'
          : 'surface';
    return (
        <div
            ref={listReference}
            role="tablist"
            aria-label={tabListLabel}
            aria-orientation="horizontal"
            className="relative flex min-w-0 flex-1"
        >
            {dropIndicatorLeft !== undefined && (
                <div
                    aria-hidden="true"
                    className="work-tab-drop-marker pointer-events-none absolute top-1 bottom-1 z-10 w-0.5 bg-accent"
                    style={{ left: dropIndicatorLeft }}
                >
                    <span className="absolute -top-0.5 left-1/2 size-1.5 -translate-x-1/2 rounded-full bg-accent" />
                </div>
            )}
            <PaneTabScrollRail
                /**
                 * Sized to its own tabs so the scrolling rail keeps the rest of the bar, capped at half of it and
                 * scrolling internally past that: a Session with many Terminals must not squeeze the documents out in
                 * the other direction. With no documents to make room for it takes the whole bar instead, so Terminals
                 * alone still divide the full width evenly the way iTerm2 and Chrome do.
                 */
                className={cn(
                    'flex-none',
                    rail.isOccupied ? 'max-w-1/2' : 'w-full',
                    !anchor.isOccupied && 'hidden',
                )}
                fill={scrollFadeFill}
                scrollClassName="work-tab-sticky"
            >
                <PaneTabSegment
                    activeTabId={activeTabId}
                    closable={closable}
                    isOnlySessionTerminal={isOnlySessionTerminal}
                    navigationTabs={orderedTabs}
                    onExitComplete={anchor.onExitComplete}
                    paneId={paneId}
                    separatorAfterLast={rail.isOccupied}
                    showActiveAccent={showActiveAccent}
                    tabs={anchoredTabs}
                />
            </PaneTabScrollRail>
            <PaneTabScrollRail
                className={cn('@container min-w-0 flex-1', !rail.isOccupied && 'hidden')}
                fill={scrollFadeFill}
                scrollClassName="work-tab-scroll"
            >
                <PaneTabSegment
                    activeTabId={activeTabId}
                    closable={closable}
                    isOnlySessionTerminal={isOnlySessionTerminal}
                    navigationTabs={orderedTabs}
                    onExitComplete={rail.onExitComplete}
                    paneId={paneId}
                    separatorAfterLast={false}
                    showActiveAccent={showActiveAccent}
                    tabs={railTabs}
                />
            </PaneTabScrollRail>
        </div>
    );
}

/**
 * One pane's own tab bar. Every pane has one, split or not, and the bar never branches on what its tabs hold: the two
 * tab components differ only in what they render inside the same `WorkTab`.
 */
/**
 * How the Open Session strip reshapes a pane bar. While the strip shows it is the window's title bar, so the root pane
 * bar becomes an ordinary surface: no drag region, no traffic-light inset, and no title-bar fill. It keeps the accent:
 * the Session level above is neutral, so the focused pane's active tab stays the screen's one durable accent (DESIGN.md
 * principle 2 and "Two tab levels"). A boolean selector, so every retained Workbench re-renders only when the strip
 * appears or disappears.
 *
 * With the strip owning the title bar, a Session whose Workbench holds no tab at all has nothing left for the root bar:
 * no tabs to list, no actions (`PaneTabActions` renders nothing for an empty pane), no drag region to keep, and no
 * other pane to drop a tab from. Rendering it would leave an empty band under the strip above the empty state.
 */
function usePaneTabBarChrome(isRootBar: boolean, hasAnyTab: boolean) {
    const isSessionTabStripVisible = useIsSessionTabStripVisible();
    return {
        isHidden: isRootBar && isSessionTabStripVisible && !hasAnyTab,
        isTitleBar: isRootBar && !isSessionTabStripVisible,
    };
}

interface PaneTabBarProperties {
    /**
     * Whether the Workbench holds more than one tab. The active accent and close buttons have no choice to express
     * below that; the New Terminal action remains reachable on hover or keyboard focus so a second Agent can start in
     * the same Session without a shortcut.
     */
    hasTabsToSwitch: boolean;
    isOnlySessionTerminal: boolean;
    isRootBar: boolean;
    pane: PaneNode;
    tabListLabel: string;
    /**
     * Whether this bar reaches the window's right edge. False for the leading pane of a side-by-side split, where the
     * drag corner below would otherwise sit in the middle of the window rather than in it.
     */
    spansWindowWidth: boolean;
}

export function PaneTabBar(properties: PaneTabBarProperties) {
    const chrome = usePaneTabBarChrome(
        properties.isRootBar,
        properties.hasTabsToSwitch || properties.pane.tabs.length > 0,
    );
    if (chrome.isHidden) return null;
    return <PaneTabBarContent {...properties} isTitleBar={chrome.isTitleBar} />;
}

function PaneTabBarContent({
    hasTabsToSwitch,
    isOnlySessionTerminal,
    isTitleBar,
    pane,
    tabListLabel,
    spansWindowWidth,
}: PaneTabBarProperties & { isTitleBar: boolean }) {
    const isPrimarySidebarVisible = useChromeLayoutStore((state) => state.primarySidebarVisible);
    const isFullScreen = useIsFullScreen();
    const listReference = useRef<HTMLDivElement>(null);
    const {
        dropIndicatorLeft,
        isDropTarget,
        onDragEnter,
        onDragLeave,
        onDragOver,
        onDragStart,
        onDrop,
    } = usePaneTabDrag(pane, listReference);
    const { anchoredTabs, orderedTabs, railTabs } = paneTabSegments(pane.tabs);
    /**
     * Whether this pane owns `activePaneId`, DESIGN.md principle 2's "one durable accent focus per screen": the tab
     * border and the pane ring express the same focus and count as one. After a split, only the focused pane's active
     * tab wears the accent border; an unfocused pane's active tab keeps its selection fill (VS Code's unfocused editor
     * group behavior) but drops the accent, so two panes never both claim the screen's one accent at once.
     */
    const activePaneId = useSessionState(usePaneViewSessionId())?.paneLayout.activePaneId;
    const showActiveAccent = hasTabsToSwitch && activePaneId === pane.id;
    const activeTab = pane.tabs.find((tab) => tab.id === pane.activeTabId) ?? pane.tabs.at(0);
    const activeTabId = activeTab?.id;
    const editorPath = editorTabActionsPath(activeTab);
    const activeTerminal = useTerminal(
        activeTab?.resource.kind === 'terminal' ? activeTab.resource.terminalId : '',
    );
    useActiveTabReveal(listReference, activeTabId, isDropTarget);
    return (
        <div
            className={cn(
                'work-tabs group/work-tabs flex h-9 flex-none bg-surface',
                // Only the Workbench-level bar carries the frameless window's drag region and the windowed traffic-light
                // inset; a pane bar inside a split is an ordinary surface. Being the drag region is also what earns it
                // the title-bar fill: a pane bar inside a split is not a title bar and keeps `surface`.
                isTitleBar &&
                    'bg-title-bar-active-background text-title-bar-active-foreground [-webkit-app-region:drag] window-inactive:bg-title-bar-inactive-background window-inactive:text-title-bar-inactive-foreground',
                isTitleBar &&
                    !isPrimarySidebarVisible &&
                    !isFullScreen &&
                    'pl-(--traffic-light-clearance)',
                isDropTarget && 'bg-elevated',
            )}
            data-pane-tab-bar={pane.id}
            onDragStart={onDragStart}
            onDragEnter={onDragEnter}
            onDragLeave={onDragLeave}
            onDragOver={onDragOver}
            onDrop={onDrop}
        >
            <PaneTabList
                activeTabId={activeTabId}
                anchoredTabs={anchoredTabs}
                closable={hasTabsToSwitch}
                dropIndicatorLeft={dropIndicatorLeft}
                isDropTarget={isDropTarget}
                isOnlySessionTerminal={isOnlySessionTerminal}
                isRootBar={isTitleBar}
                listReference={listReference}
                orderedTabs={orderedTabs}
                paneId={pane.id}
                tabListLabel={tabListLabel}
                railTabs={railTabs}
                showActiveAccent={showActiveAccent}
            />
            <PaneTabActions
                editorPath={editorPath}
                hasPaneTabs={pane.tabs.length > 0}
                hasTabsToSwitch={hasTabsToSwitch}
                paneId={pane.id}
                surfaceTerminal={
                    canSwitchTerminalSurface(activeTerminal) ? activeTerminal : undefined
                }
            />
            {/* Evenly divided tabs reach the window's right edge, so with the primarySidebar hidden this bar is the
                whole titlebar and nothing in it would be draggable. The corner inherits the bar's drag region and
                stays just wide enough to grab. It exists only for that state: `primary-sidebar-title` is a drag
                region of its own, so while the sidebar is open the window already moves from there and reserving a
                second strip would only wedge dead space beside "+": iTerm2 ends its bar at the button too. The same
                goes for a bar that stops in the middle of the window: the leading pane of a side-by-side split has a
                neighbour on its right, not the window corner, so reserving the strip there is the dead space this
                exists to avoid rather than the grab handle it exists to provide. */}
            {isTitleBar && spansWindowWidth && !isPrimarySidebarVisible && (
                <div aria-hidden="true" className="work-tabs-drag-handle h-9 w-8 flex-none" />
            )}
        </div>
    );
}
