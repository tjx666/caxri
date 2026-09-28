import type { ReactNode, RefObject } from 'react';
import { useRef, useState } from 'react';

import type { PaneNode, PaneTab, TerminalRecord } from '@caxri/protocol';
import {
    isVirtualEditorTabPath,
    parseAgentTranscriptTab,
    parseGitDiffTab,
    partitionPaneTabs,
    terminalDisplayTitle,
    terminalTabLabel,
} from '@caxri/protocol';
import { CircleAlert, Pause } from 'lucide-react';
import { AnimatePresence, domAnimation, LazyMotion } from 'motion/react';

import { Spinner } from '../../components/ui/spinner';
import { Tooltip } from '../../components/ui/tooltip';
import { cn } from '../../lib/utilities';
import { useCaxriQuery } from '../../queries/client';
import { useChromeLayoutStore } from '../../stores/chrome-layout';
import { useGitDecoration } from '../../stores/git-decorations';
import {
    useIsFullScreen,
    useProjectById,
    useSessionState,
    useTerminal,
} from '../../stores/selectors';
import { sessionViewScope, useSessionViewStore } from '../../stores/session-view';
import { closeDocumentTabs, pinDocumentTab } from '../editor/document-commands';
import {
    documentTabPathMenuState,
    resolveDocumentTabPath,
} from '../editor/document-tab-path-actions';
import { documentTabPathMenu } from '../editor/document-tab-path-menu';
import { documentTabPresentation } from '../editor/document-tab-presentation';
import { EditorTabActions } from '../editor/editor-tab-actions';
import { GitReviewTabBadge } from '../editor/git-review-tab-badge';
import { previewSourcePath } from '../preview/preview-commands';
import { moveTerminalToNewSession } from '../session/session-commands';
import { WorkTab } from '../tabs/work-tab';
import type { WorkTabNavigationKey } from '../tabs/work-tab-accessibility';
import { workTabId, workTabNavigationTarget } from '../tabs/work-tab-accessibility';
import { NewTerminalButton } from '../terminal/new-terminal-button';
import { closeTerminal } from '../terminal/terminal-commands';
import {
    terminalProgressAriaLabel,
    terminalProgressLabel,
    useTerminalProgress,
} from '../terminal/terminal-progress';
import { selectPaneTab } from './pane-actions';
import { EDITOR_PATH_DRAG_TYPE, PANE_TAB_DRAG_TYPE } from './pane-drop-zone';
import { paneTabMenu } from './pane-tab-menu';
import { useActiveTabReveal } from './pane-tab-reveal';
import { usePaneViewSession, usePaneViewSessionId } from './pane-view-session';
import { useScrollEdges } from './tab-scroll-edges';
import { usePaneTabDrag } from './use-pane-tab-drag';

interface PaneTabProperties {
    active: boolean;
    /**
     * Forwarded to `WorkTab`; `false` for the Workbench's lone tab. See `WorkTab`'s own property doc.
     */
    closable: boolean;
    onNavigate: (key: WorkTabNavigationKey) => void;
    paneId: string;
    /**
     * Forwarded to `WorkTab`; `false` for the Workbench's lone tab. See `WorkTab`'s own property doc.
     */
    showActiveAccent: boolean;
    /**
     * Forwarded to `WorkTab`; `false` for the last tab in this pane's rail. See `WorkTab`'s own property doc.
     */
    showTrailingSeparator: boolean;
    tab: PaneTab;
}

function TerminalPaneTab({
    active,
    closable,
    isOnlySessionTerminal,
    onNavigate,
    paneId,
    showActiveAccent,
    showTrailingSeparator,
    tab,
    terminal,
}: PaneTabProperties & { isOnlySessionTerminal: boolean; terminal: TerminalRecord }) {
    const paneLayout = useSessionState(usePaneViewSessionId())?.paneLayout;
    const progress = useTerminalProgress(terminal.id);
    const isCompacting = terminal.agentOperation === 'compacting';
    const ProgressIcon =
        progress?.kind === 'error' ? CircleAlert : progress?.kind === 'paused' ? Pause : undefined;
    const displayTitle = terminalDisplayTitle(terminal);
    return (
        <WorkTab
            active={active}
            fill
            accessory={
                isCompacting ? (
                    <Tooltip content="Codex is summarizing earlier context before continuing.">
                        <span
                            aria-label="Compacting context"
                            aria-live="polite"
                            className="terminal-agent-operation inline-flex flex-none items-center text-foreground"
                            data-agent-operation="compacting"
                            role="status"
                        >
                            Compacting
                        </span>
                    </Tooltip>
                ) : progress ? (
                    <span
                        aria-label={terminalProgressAriaLabel(progress)}
                        className={cn(
                            'terminal-progress-tab inline-flex flex-none items-center gap-1 tabular-nums',
                            /**
                             * `--accent` marks exactly one thing at a time — the focused pane/tab (DESIGN.md principle
                             * 2). This badge renders on every tab with progress, active or not, so a background `npm
                             * install` must not wear the same accent color the focused tab's ring already owns.
                             */
                            progress.kind === 'normal' && 'text-muted',
                            progress.kind === 'error' && 'text-danger',
                            progress.kind === 'paused' && 'text-warning',
                        )}
                        data-terminal-progress-state={progress.kind}
                        title={terminalProgressAriaLabel(progress)}
                    >
                        {progress.kind === 'indeterminate' ? (
                            <Spinner aria-hidden="true" size={11} />
                        ) : (
                            ProgressIcon && <ProgressIcon aria-hidden="true" size={11} />
                        )}
                        {progress.kind !== 'indeterminate' && terminalProgressLabel(progress)}
                    </span>
                ) : undefined
            }
            closable={closable}
            closeLabel="Close Terminal"
            icon={terminal.kind}
            label={terminalTabLabel(displayTitle)}
            labelTooltip={displayTitle}
            showActiveAccent={showActiveAccent}
            showTrailingSeparator={showTrailingSeparator}
            tabId={workTabId(tab.id)}
            paneTabId={tab.id}
            terminalId={terminal.id}
            onClose={() => closeTerminal(terminal.id)}
            onDragStart={(event) => {
                event.dataTransfer.effectAllowed = 'move';
                event.dataTransfer.setData(PANE_TAB_DRAG_TYPE, tab.id);
            }}
            onKeyDown={(event) => {
                if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
                event.preventDefault();
                onNavigate(event.key as WorkTabNavigationKey);
            }}
            onSelect={() => selectPaneTab(tab.id)}
            contextMenu={() =>
                paneTabMenu({
                    paneId,
                    paneLayout,
                    tabId: tab.id,
                    resourceEntries: [
                        {
                            label: 'Move to New Session',
                            disabled: isOnlySessionTerminal,
                            disabledReason: 'This is the only tab open in this session',
                            onSelect: () =>
                                moveTerminalToNewSession(terminal.id, isOnlySessionTerminal),
                        },
                    ],
                })
            }
        />
    );
}

/**
 * Subscribes to its own document so a keystroke only rerenders the tab whose dirty flag flipped.
 */
function DocumentPaneTab({
    active,
    closable,
    onNavigate,
    paneId,
    path,
    showActiveAccent,
    showTrailingSeparator,
    tab,
}: PaneTabProperties & { path: string }) {
    const session = usePaneViewSession();
    /**
     * Keep context-menu close actions in sync when other tabs open or close.
     */
    const paneLayout = useSessionState(usePaneViewSessionId())?.paneLayout;
    const transcriptTab = parseAgentTranscriptTab(path);
    const project = useProjectById(session?.workbenchProjectId);
    const overviewQuery = useCaxriQuery(
        'git.overview',
        { sessionId: session?.id ?? '' },
        { enabled: Boolean(session), staleTime: 60_000 },
    );
    // Tab identity is the terminal ID alone; the label follows its stable semantic title, never a PTY window title.
    const transcriptTerminal = useTerminal(transcriptTab?.terminalId ?? '');
    const document = useSessionViewStore((state) =>
        session
            ? state.documents[sessionViewScope(session.id, session.workbenchProjectId)]?.[path]
            : undefined,
    );
    const resolution = resolveDocumentTabPath(path, {
        projectRoot: project?.rootPath,
        repositories: overviewQuery.data?.repositories,
        externalDisplayPath: document?.displayPath,
    });
    /**
     * Keyed on the resolved filesystem path, not the tab's own `path`: a single-file Git diff tab carries a virtual URI
     * whose repository-relative path only `resolveDocumentTabPath` can turn into the absolute path Git reports.
     */
    const gitDecoration = useGitDecoration(resolution?.absolutePath);
    const pathMenu = documentTabPathMenuState(path, overviewQuery);
    const presentation = documentTabPresentation(path, {
        displayPath: document?.displayPath,
        transcriptTitle: transcriptTerminal?.title,
    });
    return (
        <WorkTab
            active={active}
            accessory={<GitReviewTabBadge sessionId={session?.id} tabPath={path} />}
            fill={false}
            closable={closable}
            closeLabel="Close Editor"
            dirty={document?.dirty}
            fileIconName={presentation.fileIconName}
            gitDecoration={gitDecoration}
            icon="file"
            label={presentation.label}
            // Ordinary files expose their full path on hover; virtual resources reuse their descriptive label.
            labelTooltip={presentation.labelTooltip}
            // The full path is a different detail than the filename, not a fuller version of it, so it must not
            // replace the filename a screen reader announces the way a Terminal's untruncated title does.
            keepLabelAsAccessibleName
            motionIdentity={tab.id}
            showActiveAccent={showActiveAccent}
            showTrailingSeparator={showTrailingSeparator}
            tabId={workTabId(tab.id)}
            paneTabId={tab.id}
            onDoubleClick={() => {
                if (session) pinDocumentTab(session.id, tab.id);
            }}
            onClose={() => {
                // eslint-disable-next-line no-void -- intentional floating-promise discard, closeDocumentTabs() reports its own errors
                void closeDocumentTabs([tab.id]);
            }}
            onDragStart={(event) => {
                event.dataTransfer.effectAllowed = 'copyMove';
                event.dataTransfer.setData(PANE_TAB_DRAG_TYPE, tab.id);
                if (resolution)
                    event.dataTransfer.setData(EDITOR_PATH_DRAG_TYPE, resolution.absolutePath);
                event.dataTransfer.setData('text/plain', resolution?.absolutePath ?? path);
            }}
            onKeyDown={(event) => {
                if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
                event.preventDefault();
                onNavigate(event.key as WorkTabNavigationKey);
            }}
            onSelect={() => selectPaneTab(tab.id)}
            contextMenu={() =>
                paneTabMenu({
                    paneId,
                    paneLayout,
                    tabId: tab.id,
                    resourceEntries: pathMenu.showMenu
                        ? documentTabPathMenu({
                              resolution,
                              unavailableReason: pathMenu.unavailableReason,
                              isExternal: pathMenu.isExternal,
                              previewPath: previewSourcePath(path),
                          })
                        : undefined,
                })
            }
            preview={tab.preview}
        />
    );
}

function PaneTabEntry(properties: PaneTabProperties & { isOnlySessionTerminal: boolean }) {
    const terminalId =
        properties.tab.resource.kind === 'terminal'
            ? properties.tab.resource.terminalId
            : undefined;
    const liveTerminal = useTerminal(terminalId ?? '');
    /**
     * `AnimatePresence` keeps this component mounted through its exit transition after `tab` drops out of the pane, but
     * a Terminal close removes the record `useTerminal` reads in that same store update — without this snapshot the
     * exit render sees `terminal === undefined` and bails to `null` one commit into the transition, unmounting
     * `WorkTab` before it ever renders `aria-hidden`/plays its exit animation. This follows React's documented
     * "adjusting state during render" pattern
     * (https://react.dev/reference/react/useState#storing-information-from-previous-renders) instead of a ref, since
     * this repo's lint config forbids reading `ref.current` during render.
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
 * The path the tab actions operate on, or `undefined` when the active tab is not an editable document. A virtual tab
 * has no file behind it and so offers no actions, except a Git diff, whose target is a real path the actions can
 * reach.
 */
function activeEditorPath(tab: PaneTab | undefined): string | undefined {
    if (tab?.resource.kind !== 'file') return undefined;
    const { path } = tab.resource;
    if (!isVirtualEditorTabPath(path)) return path;
    return parseGitDiffTab(path) ? path : undefined;
}

/**
 * Which fill the scroll cue has to blend into, named in the bar's own precedence order: the drop-target tint covers
 * everything, then the Workbench bar's title-bar fill, then an ordinary pane bar's surface.
 */
type ScrollFadeFill = 'dropTarget' | 'surface' | 'titleBar';

const SCROLL_FADE_FILL_CLASS_NAME: Record<ScrollFadeFill, string> = {
    dropTarget: 'from-elevated',
    surface: 'from-surface',
    // Tracks the root bar's own two states, so the cue stays seamless when the window loses focus.
    titleBar: 'from-title-bar-active-background window-inactive:from-title-bar-inactive-background',
};

/**
 * The gradient cue for one end of the scrollable rail. It appears only on an edge that actually hides tabs, and fades
 * to whatever background the bar itself currently wears so the cue never draws a visible seam against it.
 * `motion-safe:` keeps the appear/disappear crossfade off entirely under reduced motion (DESIGN.md's motion layer
 * contract), leaving an instant show/hide.
 */
function ScrollFade({ edge, fill }: { edge: 'end' | 'start'; fill: ScrollFadeFill }) {
    return (
        <div
            aria-hidden="true"
            className={cn(
                'pointer-events-none absolute inset-y-0 z-[4] w-6 to-transparent motion-safe:transition-opacity motion-safe:duration-150',
                edge === 'start' ? 'left-0 bg-gradient-to-r' : 'right-0 bg-gradient-to-l',
                SCROLL_FADE_FILL_CLASS_NAME[fill],
            )}
        />
    );
}

/**
 * The bar's trailing strip. With one tab, + floats over its end: a reserved slot showed the bar's fill as a block.
 */
function PaneTabActions({
    editorPath,
    hasPaneTabs,
    hasTabsToSwitch,
    paneId,
}: {
    editorPath: string | undefined;
    hasPaneTabs: boolean;
    hasTabsToSwitch: boolean;
    paneId: string;
}) {
    if (!editorPath && !hasPaneTabs) return null;
    return (
        <div
            className={`tab-actions relative flex h-11 flex-none items-center [-webkit-app-region:no-drag] ${editorPath || hasTabsToSwitch ? 'px-1' : ''}`}
        >
            {editorPath && <EditorTabActions paneId={paneId} path={editorPath} />}
            {hasPaneTabs && (
                <div
                    className={cn(
                        !hasTabsToSwitch &&
                            'absolute top-0 right-full z-[5] flex h-11 items-center pr-1 opacity-0 [-webkit-app-region:no-drag] group-hover/work-tabs:opacity-100 focus-within:opacity-100 has-[[data-popup-open]]:opacity-100',
                    )}
                >
                    <NewTerminalButton paneId={paneId} />
                </div>
            )}
        </div>
    );
}

/**
 * Moves roving tab focus one step through `tabs` and selects whatever it lands on, leaving focus where it was when the
 * key has no target — the ends of the rail for `ArrowLeft`/`ArrowRight`.
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
     * keyboard — roving tab navigation here, drag hover previews in `previewTab` — and is removed on blur, so the
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
 * The two containers the bar lays out — the anchored Terminal segment and the scrolling document rail — plus the visual
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
 * segment a beat early. An empty segment is hidden rather than unmounted — its rail is what the tab-bar specs and the
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
 * that there is more to either side, and both segments can overflow — the documents routinely, the Terminals once
 * enough of them share the anchored half — so each gets its own rather than the bar cueing only one of them.
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
                    className="work-tab-list flex h-11 min-w-full items-stretch"
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
 * drag draws across both. Both containers stay mounted for the pane's whole life — which of the two a tab belongs to is
 * fixed by its resource kind — so the only thing that changes as tabs come and go is how the width is split.
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
    paneLabel,
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
    paneLabel: string;
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
            aria-label={`Open tabs in ${paneLabel}`}
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
                 * scrolling internally past that — a Session with many Terminals must not squeeze the documents out in
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
                className={cn('min-w-0 flex-1', !rail.isOccupied && 'hidden')}
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
export function PaneTabBar({
    hasTabsToSwitch,
    isOnlySessionTerminal,
    isRootBar,
    pane,
    paneLabel,
    spansWindowWidth,
}: {
    /**
     * Whether the Workbench holds more than one tab. The active accent and close buttons have no choice to express
     * below that; the New Terminal action remains reachable on hover or keyboard focus so a second Agent can start in
     * the same Session without a shortcut.
     */
    hasTabsToSwitch: boolean;
    isOnlySessionTerminal: boolean;
    isRootBar: boolean;
    pane: PaneNode;
    paneLabel: string;
    /**
     * Whether this bar reaches the window's right edge. False for the leading pane of a side-by-side split, where the
     * drag corner below would otherwise sit in the middle of the window rather than in it.
     */
    spansWindowWidth: boolean;
}) {
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
     * Whether this pane owns `activePaneId` — DESIGN.md principle 2's "one durable accent focus per screen": the tab
     * border and the pane ring express the same focus and count as one. After a split, only the focused pane's active
     * tab wears the accent border; an unfocused pane's active tab keeps its selection fill (VS Code's unfocused editor
     * group behavior) but drops the accent, so two panes never both claim the screen's one accent at once.
     */
    const activePaneId = useSessionState(usePaneViewSessionId())?.paneLayout.activePaneId;
    const showActiveAccent = hasTabsToSwitch && activePaneId === pane.id;
    const activeTab = pane.tabs.find((tab) => tab.id === pane.activeTabId) ?? pane.tabs.at(0);
    const activeTabId = activeTab?.id;
    const editorPath = activeEditorPath(activeTab);
    useActiveTabReveal(listReference, activeTabId, isDropTarget);
    return (
        <div
            className={cn(
                'work-tabs group/work-tabs flex h-11 flex-none bg-surface',
                // Only the Workbench-level bar carries the frameless window's drag region and the windowed traffic-light
                // inset; a pane bar inside a split is an ordinary surface. Being the drag region is also what earns it
                // the title-bar fill — a pane bar inside a split is not a title bar and keeps `surface`.
                isRootBar &&
                    'bg-title-bar-active-background text-title-bar-active-foreground [-webkit-app-region:drag] window-inactive:bg-title-bar-inactive-background window-inactive:text-title-bar-inactive-foreground',
                isRootBar &&
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
                isRootBar={isRootBar}
                listReference={listReference}
                orderedTabs={orderedTabs}
                paneId={pane.id}
                paneLabel={paneLabel}
                railTabs={railTabs}
                showActiveAccent={showActiveAccent}
            />
            <PaneTabActions
                editorPath={editorPath}
                hasPaneTabs={pane.tabs.length > 0}
                hasTabsToSwitch={hasTabsToSwitch}
                paneId={pane.id}
            />
            {/* Evenly divided tabs reach the window's right edge, so with the primarySidebar hidden this bar is the
                whole titlebar and nothing in it would be draggable. The corner inherits the bar's drag region and
                stays just wide enough to grab. It exists only for that state: `primary-sidebar-title` is a drag
                region of its own, so while the sidebar is open the window already moves from there and reserving a
                second strip would only wedge dead space beside "+" — iTerm2 ends its bar at the button too. The same
                goes for a bar that stops in the middle of the window: the leading pane of a side-by-side split has a
                neighbour on its right, not the window corner, so reserving the strip there is the dead space this
                exists to avoid rather than the grab handle it exists to provide. */}
            {isRootBar && spansWindowWidth && !isPrimarySidebarVisible && (
                <div aria-hidden="true" className="work-tabs-drag-handle h-11 w-8 flex-none" />
            )}
        </div>
    );
}
