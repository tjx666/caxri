import type { DragEvent } from 'react';
import { useEffect, useRef, useState } from 'react';

import { pathBasename } from '@caxri/utils';
import { agentTranscriptTabLabel, parseAgentTranscriptTab } from '@shared/agent-transcript';
import { gitDiffTabLabel, parseGitDiffTab } from '@shared/git-diff';
import { terminalDisplayTitle, terminalTabLabel } from '@shared/terminal-title';
import type { PaneNode, PaneTab, TerminalRecord } from '@shared/types';
import { CircleAlert, Pause, Plus } from 'lucide-react';
import { AnimatePresence, domAnimation, LazyMotion } from 'motion/react';

import { Button } from '../../components/ui/button';
import { ContextMenuItem } from '../../components/ui/context-menu';
import { Spinner } from '../../components/ui/spinner';
import { CommandTooltip, Tooltip } from '../../components/ui/tooltip';
import { cn } from '../../lib/utilities';
import { useChromeLayoutStore } from '../../stores/chrome-layout';
import { useSelectedSession, useSessionState, useTerminal } from '../../stores/selectors';
import { sessionViewScope, useSessionViewStore } from '../../stores/session-view';
import { closeDocumentTabs, pinDocumentTab } from '../editor/document-actions';
import {
    sessionActivityPresentation,
    sessionToneBackgroundClassName,
} from '../primary-sidebar/session-activity';
import { moveTerminalToNewSession } from '../session/session-actions';
import { WorkTab } from '../tabs/work-tab';
import type { WorkTabNavigationKey } from '../tabs/work-tab-accessibility';
import { workTabId, workTabNavigationTarget } from '../tabs/work-tab-accessibility';
import { closeTerminal, createTerminal } from '../terminal/terminal-actions';
import {
    terminalProgressAriaLabel,
    terminalProgressLabel,
    useTerminalProgress,
} from '../terminal/terminal-progress';
import { movePaneTab, selectPaneTab } from './pane-actions';
import { PANE_TAB_DRAG_TYPE, resolveTabDropIndex } from './pane-drop-zone';
import { PaneTabMenu } from './pane-tab-menu';

function canAcceptDrop(event: DragEvent<HTMLElement>): boolean {
    return event.dataTransfer.types.includes(PANE_TAB_DRAG_TYPE);
}

/**
 * How long a drag has to linger over another tab before that tab's pane treats it as selected, previewing its content
 * the way VS Code does while a tab drag is still in progress (`multiEditorTabsControl.ts`,
 * `DRAG_OVER_OPEN_TAB_THRESHOLD`). The value matches VS Code's deliberately unhurried 1.5s: a shorter delay flips the
 * content under a cursor that is only passing over a tab on its way to the drop position. Mirrors
 * `AUTO_COLLAPSE_IDLE_DELAY_MS`'s naming (`use-project-collapse.ts`).
 */
const TAB_DRAG_HOVER_SWITCH_DELAY_MS = 1500;

function paneTabIdAt(target: EventTarget | null): string | undefined {
    return target instanceof Element
        ? (target.closest<HTMLElement>('[data-pane-tab-id]')?.dataset.paneTabId ?? undefined)
        : undefined;
}

/**
 * Agent activity for the Terminal that owns the selected Session's title, or `undefined` for a Shell and for a
 * secondary Agent Terminal whose activity the Session read model does not track.
 */
function useAgentTabActivity(
    terminalId: string,
): { className: string; description: string } | undefined {
    const session = useSelectedSession();
    if (session?.primaryAgentTerminalId !== terminalId) return undefined;
    const activity = sessionActivityPresentation(session.lastActivityState);
    return {
        className: sessionToneBackgroundClassName(activity.tone),
        description: activity.ariaLabel,
    };
}

interface PaneTabProperties {
    active: boolean;
    onNavigate: (key: WorkTabNavigationKey) => void;
    paneId: string;
    /**
     * Forwarded to `WorkTab`; `false` for the Workbench's lone tab. See `WorkTab`'s own property doc.
     */
    showActiveAccent: boolean;
    tab: PaneTab;
}

function TerminalPaneTab({
    active,
    isOnlySessionTerminal,
    onNavigate,
    paneId,
    showActiveAccent,
    tab,
    terminal,
}: PaneTabProperties & { isOnlySessionTerminal: boolean; terminal: TerminalRecord }) {
    const paneLayout = useSessionState()?.paneLayout;
    const progress = useTerminalProgress(terminal.id);
    const isCompacting = terminal.agentOperation === 'compacting';
    const ProgressIcon =
        progress?.kind === 'error' ? CircleAlert : progress?.kind === 'paused' ? Pause : undefined;
    const activity = useAgentTabActivity(terminal.id);
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
                            className="terminal-agent-operation inline-flex flex-none items-center text-muted"
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
            closeLabel="Close Terminal"
            icon={terminal.kind}
            label={terminalTabLabel(displayTitle)}
            labelTooltip={displayTitle}
            showActiveAccent={showActiveAccent}
            status={terminal.lastProcessState}
            statusActivity={activity}
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
            contextMenu={
                <PaneTabMenu
                    paneId={paneId}
                    paneLayout={paneLayout}
                    tabId={tab.id}
                    resourceItems={
                        <ContextMenuItem
                            disabledReason={
                                isOnlySessionTerminal
                                    ? 'This is the only tab open in this session'
                                    : undefined
                            }
                            disabled={isOnlySessionTerminal}
                            onClick={() =>
                                moveTerminalToNewSession(terminal.id, isOnlySessionTerminal)
                            }
                        >
                            Move to New Session
                        </ContextMenuItem>
                    }
                />
            }
        />
    );
}

/**
 * Subscribes to its own document so a keystroke only rerenders the tab whose dirty flag flipped.
 */
function DocumentPaneTab({
    active,
    onNavigate,
    paneId,
    path,
    showActiveAccent,
    tab,
}: PaneTabProperties & { path: string }) {
    const session = useSelectedSession();
    /**
     * Read reactively (not through the imperative `getPaneLayout` other actions use): an on-demand store read inside
     * the `contextMenu` JSX tree does not reliably reflect the latest layout once other tabs open or close around it,
     * leaving "Close to the Right" etc. stuck at a stale disabled state.
     */
    const paneLayout = useSessionState()?.paneLayout;
    const gitDiffTab = parseGitDiffTab(path);
    const transcriptTab = parseAgentTranscriptTab(path);
    // Tab identity is the terminal ID alone; the label follows its stable semantic title, never a PTY window title.
    const transcriptTerminal = useTerminal(transcriptTab?.terminalId ?? '');
    const isDirty = useSessionViewStore((state) =>
        session
            ? state.documents[sessionViewScope(session.id, session.workbenchProjectId)]?.[path]
                  ?.dirty
            : false,
    );
    return (
        <WorkTab
            active={active}
            fill={false}
            closeLabel="Close Editor"
            dirty={isDirty}
            fileIconName={
                gitDiffTab?.kind === 'file'
                    ? pathBasename(gitDiffTab.path)
                    : gitDiffTab?.kind === 'changes'
                      ? 'changes.diff'
                      : transcriptTab
                        ? 'transcript.jsonl'
                        : pathBasename(path)
            }
            icon="file"
            label={
                gitDiffTab
                    ? gitDiffTabLabel(gitDiffTab)
                    : transcriptTab
                      ? agentTranscriptTabLabel(transcriptTerminal?.title)
                      : pathBasename(path)
            }
            // Document tabs cap at 160px (see ADR 0002 "Tab sizing") and truncate with an ellipsis, so a mouse
            // user needs the hover path to recover a name that got cut off; a diff/transcript tab reuses its own
            // label since it has no full path of its own.
            labelTooltip={
                gitDiffTab
                    ? gitDiffTabLabel(gitDiffTab)
                    : transcriptTab
                      ? agentTranscriptTabLabel(transcriptTerminal?.title)
                      : path
            }
            // The full path is a different detail than the filename, not a fuller version of it, so it must not
            // replace the filename a screen reader announces the way a Terminal's untruncated title does.
            keepLabelAsAccessibleName
            motionIdentity={tab.id}
            showActiveAccent={showActiveAccent}
            tabId={workTabId(tab.id)}
            paneTabId={tab.id}
            onDoubleClick={() => pinDocumentTab(tab.id)}
            onClose={() => {
                // eslint-disable-next-line no-void -- intentional floating-promise discard, closeDocumentTabs() reports its own errors
                void closeDocumentTabs([tab.id]);
            }}
            onDragStart={(event) => {
                event.dataTransfer.effectAllowed = 'move';
                event.dataTransfer.setData(PANE_TAB_DRAG_TYPE, tab.id);
                event.dataTransfer.setData('text/plain', path);
            }}
            onKeyDown={(event) => {
                if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
                event.preventDefault();
                onNavigate(event.key as WorkTabNavigationKey);
            }}
            onSelect={() => selectPaneTab(tab.id)}
            contextMenu={<PaneTabMenu paneId={paneId} paneLayout={paneLayout} tabId={tab.id} />}
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
 * One pane's own tab bar. Every pane has one, split or not, and the bar never branches on what its tabs hold: the two
 * tab components differ only in what they render inside the same `WorkTab`.
 */
export function PaneTabBar({
    hasTabsToSwitch,
    isOnlySessionTerminal,
    isRootBar,
    pane,
    paneLabel,
}: {
    /**
     * Whether the Workbench holds more than one tab. Both affordances a tab bar adds on top of the tabs themselves —
     * the active accent and the "New Terminal" button — are noise below that: with one tab there is nothing to switch
     * between and with none there is nothing to mark, and the empty pane offers its own "New Terminal" button. iTerm2
     * likewise shows neither until a second tab exists, and `cmd+t` plus the application menu keep the command
     * reachable meanwhile.
     */
    hasTabsToSwitch: boolean;
    isOnlySessionTerminal: boolean;
    isRootBar: boolean;
    pane: PaneNode;
    paneLabel: string;
}) {
    const isPrimarySidebarVisible = useChromeLayoutStore((state) => state.primarySidebarVisible);
    const [isDropTarget, setIsDropTarget] = useState(false);
    const [dropIndicatorLeft, setDropIndicatorLeft] = useState<number | undefined>(undefined);
    const barReference = useRef<HTMLDivElement>(null);
    const hoverTabIdReference = useRef<string | undefined>(undefined);
    const hoverTimeoutReference = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
    /**
     * `dataTransfer.getData` cannot be read during `dragover` (only `types` is exposed before `drop`), so — mirroring
     * `draggedProjectId` in `use-project-order.ts` — the id is captured off the bubbled `dragstart` DOM event instead,
     * which lets `dragover` exclude the dragged tab's own (unmoved) rect from both the insertion-line geometry and the
     * hover-preview target, the same way `onDrop` below already excludes it from its own rects.
     */
    const draggedTabIdReference = useRef<string | undefined>(undefined);
    const clearHoverSwitch = (): void => {
        hoverTabIdReference.current = undefined;
        clearTimeout(hoverTimeoutReference.current);
        hoverTimeoutReference.current = undefined;
    };
    useEffect(() => {
        /**
         * `dragend` fires on the drag source and only bubbles through its own bar's ancestors, so a drag cancelled
         * (Escape, dropped outside any bar) while over a _different_ pane's bar would otherwise leave that other bar's
         * insertion line and pending hover-switch timer stuck. A window-level listener clears every bar's state.
         */
        const onWindowDragEnd = (): void => {
            setDropIndicatorLeft(undefined);
            clearHoverSwitch();
            draggedTabIdReference.current = undefined;
        };
        addEventListener('dragend', onWindowDragEnd);
        return () => {
            removeEventListener('dragend', onWindowDragEnd);
            clearHoverSwitch();
        };
    }, []);
    const activeTabId =
        pane.tabs.find((tab) => tab.id === pane.activeTabId)?.id ?? pane.tabs[0]?.id;
    /**
     * `overflow-x-auto` has no built-in cue for "the active tab is off to the side," so selecting or creating a tab
     * that lands outside the visible bar must scroll it into view itself.
     */
    useEffect(() => {
        barReference.current
            ?.querySelector<HTMLElement>('[data-tab-active="true"]')
            ?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }, [activeTabId]);
    const navigate = (fromTabId: string, key: WorkTabNavigationKey): void => {
        const target = workTabNavigationTarget(
            pane.tabs.map((tab) => tab.id),
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
            const tab = pane.tabs.find((candidate) => candidate.id === target);
            if (tab?.resource.kind === 'terminal') targetTab.dataset.preserveTerminalFocus = 'true';
            targetTab.focus();
        }
        selectPaneTab(target);
    };
    /**
     * Activating a tab under a live drag must not hand it the keyboard: VS Code previews the dragged-over editor with
     * `openEditor(..., { preserveFocus: true })` (`multiEditorTabsControl.ts`). A previewed Terminal would otherwise
     * pull focus into xterm mid-drag, so it reuses `navigate`'s marker — Document tabs never move focus on activation
     * and are left alone.
     */
    const previewTab = (tabId: string): void => {
        const tab = pane.tabs.find((candidate) => candidate.id === tabId);
        if (tab?.resource.kind === 'terminal') {
            const element = document.querySelector<HTMLElement>(`#${CSS.escape(workTabId(tabId))}`);
            if (element) {
                element.dataset.preserveTerminalFocus = 'true';
                element.focus();
            }
        }
        selectPaneTab(tabId);
    };
    return (
        <div
            className={cn(
                'work-tabs flex h-11 flex-none bg-surface',
                // Only the Workbench-level bar carries the frameless window's drag region and the traffic-light inset;
                // a pane bar inside a split is an ordinary surface.
                isRootBar && '[-webkit-app-region:drag]',
                isRootBar && !isPrimarySidebarVisible && 'pl-[78px]',
                isDropTarget && 'bg-elevated',
            )}
            data-pane-tab-bar={pane.id}
            onDragStart={(event) => {
                draggedTabIdReference.current = paneTabIdAt(event.target);
            }}
            onDragEnter={(event) => {
                if (!canAcceptDrop(event)) return;
                event.preventDefault();
                setIsDropTarget(true);
            }}
            onDragLeave={(event) => {
                if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
                setIsDropTarget(false);
                setDropIndicatorLeft(undefined);
                clearHoverSwitch();
            }}
            onDragOver={(event) => {
                if (!canAcceptDrop(event)) return;
                event.preventDefault();
                event.dataTransfer.dropEffect = 'move';
                /**
                 * Lingering over another tab previews its content, matching VS Code: the drop still lands where the
                 * insertion line points, but the user can see what they are dropping next to while the drag is live.
                 */
                const hoveredTabId = paneTabIdAt(event.target);
                const hoverSwitchTargetId =
                    hoveredTabId !== draggedTabIdReference.current ? hoveredTabId : undefined;
                if (hoverSwitchTargetId !== hoverTabIdReference.current) {
                    hoverTabIdReference.current = hoverSwitchTargetId;
                    clearTimeout(hoverTimeoutReference.current);
                    hoverTimeoutReference.current = hoverSwitchTargetId
                        ? setTimeout(
                              () => previewTab(hoverSwitchTargetId),
                              TAB_DRAG_HOVER_SWITCH_DELAY_MS,
                          )
                        : undefined;
                }
                const scrollElement = barReference.current;
                if (!scrollElement) return;
                const tabElements =
                    scrollElement.querySelectorAll<HTMLElement>('[data-pane-tab-id]');
                const tabRects: DOMRect[] = [];
                for (const element of tabElements) {
                    if (element.dataset.paneTabId !== draggedTabIdReference.current)
                        tabRects.push(element.getBoundingClientRect());
                }
                if (tabRects.length === 0) return;
                const index = resolveTabDropIndex(tabRects, event.clientX);
                const targetRect = index === undefined ? tabRects.at(-1) : tabRects[index];
                if (!targetRect) return;
                const scrollRect = scrollElement.getBoundingClientRect();
                const edgeX = index === undefined ? targetRect.right : targetRect.left;
                setDropIndicatorLeft(edgeX - scrollRect.left + scrollElement.scrollLeft);
            }}
            onDrop={(event) => {
                setIsDropTarget(false);
                setDropIndicatorLeft(undefined);
                clearHoverSwitch();
                draggedTabIdReference.current = undefined;
                const tabId = event.dataTransfer.getData(PANE_TAB_DRAG_TYPE);
                if (!tabId) return;
                event.preventDefault();
                const tabElements =
                    barReference.current?.querySelectorAll<HTMLElement>('[data-pane-tab-id]') ?? [];
                const tabRects: DOMRect[] = [];
                for (const element of tabElements) {
                    if (element.dataset.paneTabId !== tabId)
                        tabRects.push(element.getBoundingClientRect());
                }
                movePaneTab(tabId, pane.id, resolveTabDropIndex(tabRects, event.clientX));
            }}
        >
            <div
                ref={barReference}
                className="work-tab-scroll relative flex min-w-0 flex-1 overflow-x-auto"
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
                <div
                    /**
                     * `min-w-full` (not `w-full`) lets evenly divided tabs claim the whole rail while still allowing
                     * the list to grow past it once enough tabs hit their minimum width, which is what hands overflow
                     * back to the scroll container above.
                     */
                    className="work-tab-list flex h-11 min-w-full items-stretch"
                    role="tablist"
                    aria-label={`Open tabs in ${paneLabel}`}
                    aria-orientation="horizontal"
                >
                    <LazyMotion strict features={domAnimation}>
                        <AnimatePresence initial={false}>
                            {pane.tabs.map((tab) => (
                                <PaneTabEntry
                                    key={tab.id}
                                    active={tab.id === activeTabId}
                                    isOnlySessionTerminal={isOnlySessionTerminal}
                                    onNavigate={(key) => navigate(tab.id, key)}
                                    paneId={pane.id}
                                    showActiveAccent={hasTabsToSwitch}
                                    tab={tab}
                                />
                            ))}
                        </AnimatePresence>
                    </LazyMotion>
                </div>
            </div>
            {hasTabsToSwitch && (
                <div className="tab-actions flex h-11 flex-none items-center bg-surface px-1 [-webkit-app-region:no-drag]">
                    <CommandTooltip commandId="terminal.new">
                        <Button
                            size="icon"
                            variant="ghost"
                            aria-label="New Terminal"
                            onClick={() => {
                                // eslint-disable-next-line no-void -- intentional floating-promise discard, createTerminal() reports its own errors via tryCommand
                                void createTerminal('shell', { paneId: pane.id });
                            }}
                        >
                            <Plus size={14} />
                        </Button>
                    </CommandTooltip>
                </div>
            )}
            {/* Evenly divided tabs reach the window's right edge, so with the primarySidebar hidden this bar is the
                whole titlebar and nothing in it would be draggable. The corner inherits the bar's drag region and
                stays just wide enough to grab. It exists only for that state: `primary-sidebar-title` is a drag
                region of its own, so while the sidebar is open the window already moves from there and reserving a
                second strip would only wedge dead space beside "+" — iTerm2 ends its bar at the button too. */}
            {isRootBar && !isPrimarySidebarVisible && (
                <div aria-hidden="true" className="work-tabs-drag-handle h-11 w-8 flex-none" />
            )}
        </div>
    );
}
