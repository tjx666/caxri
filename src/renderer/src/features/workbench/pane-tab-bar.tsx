import type { DragEvent } from 'react';
import { useEffect, useRef, useState } from 'react';

import { pathBasename } from '@caxri/utils';
import { agentTranscriptTabLabel, parseAgentTranscriptTab } from '@shared/agent-transcript';
import { gitDiffTabLabel, parseGitDiffTab } from '@shared/git-diff';
import { terminalTabLabel } from '@shared/terminal-title';
import type { PaneNode, PaneTab, TerminalRecord } from '@shared/types';
import { CircleAlert, Pause, Plus } from 'lucide-react';
import { AnimatePresence, domAnimation, LazyMotion } from 'motion/react';

import { Button } from '../../components/ui/button';
import {
    ContextMenuContent,
    ContextMenuItem,
    ContextMenuSeparator,
} from '../../components/ui/context-menu';
import { Spinner } from '../../components/ui/spinner';
import { CommandTooltip, Tooltip } from '../../components/ui/tooltip';
import { cn } from '../../lib/utilities';
import { usePanelLayoutStore } from '../../stores/panel-layout';
import { useSelectedSession, useTerminal } from '../../stores/selectors';
import { sessionViewScope, useSessionViewStore } from '../../stores/session-view';
import { closeDocumentTabs, pinDocumentTab } from '../editor/document-actions';
import { moveTerminalToNewSession } from '../session/session-actions';
import {
    sessionActivityPresentation,
    sessionToneBackgroundClassName,
} from '../sidebar/session-activity';
import { WorkTab } from '../tabs/work-tab';
import type { WorkTabNavigationKey } from '../tabs/work-tab-accessibility';
import { workTabId, workTabNavigationTarget } from '../tabs/work-tab-accessibility';
import { closeTerminal, createTerminal } from '../terminal/terminal-actions';
import {
    terminalProgressAriaLabel,
    terminalProgressLabel,
    useTerminalProgress,
} from '../terminal/terminal-progress';
import { movePaneTab, paneTabCloseFamily, selectPaneTab, splitPaneTab } from './pane-actions';
import { PANE_TAB_DRAG_TYPE } from './pane-drop-zone';

function canAcceptDrop(event: DragEvent<HTMLElement>): boolean {
    return event.dataTransfer.types.includes(PANE_TAB_DRAG_TYPE);
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
    tab: PaneTab;
}

function TerminalPaneTab({
    active,
    isOnlySessionTerminal,
    onNavigate,
    tab,
    terminal,
}: PaneTabProperties & { isOnlySessionTerminal: boolean; terminal: TerminalRecord }) {
    const progress = useTerminalProgress(terminal.id);
    const isCompacting = terminal.agentOperation === 'compacting';
    const ProgressIcon =
        progress?.kind === 'error' ? CircleAlert : progress?.kind === 'paused' ? Pause : undefined;
    const activity = useAgentTabActivity(terminal.id);
    return (
        <WorkTab
            active={active}
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
            label={terminalTabLabel(terminal.title)}
            labelTooltip={terminal.title}
            status={terminal.lastProcessState}
            statusActivity={activity}
            tabId={workTabId(tab.id)}
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
                <ContextMenuContent>
                    <ContextMenuItem
                        disabledReason={
                            isOnlySessionTerminal
                                ? 'This is the only tab open in this session'
                                : undefined
                        }
                        disabled={isOnlySessionTerminal}
                        onClick={() => moveTerminalToNewSession(terminal.id, isOnlySessionTerminal)}
                    >
                        Move to New Session
                    </ContextMenuItem>
                </ContextMenuContent>
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
    tab,
}: PaneTabProperties & { path: string }) {
    const session = useSelectedSession();
    const gitDiffTab = parseGitDiffTab(path);
    const transcriptTab = parseAgentTranscriptTab(path);
    // Tab identity is the terminal ID alone; the label follows the terminal's live title.
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
            motionIdentity={tab.id}
            tabId={workTabId(tab.id)}
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
            contextMenu={
                <ContextMenuContent>
                    {(['one', 'others', 'right', 'all'] as const).map((mode) => (
                        <ContextMenuItem
                            key={mode}
                            disabled={paneTabCloseFamily(tab.id, mode).length === 0}
                            onClick={() => {
                                // eslint-disable-next-line no-void -- intentional floating-promise discard, closeDocumentTabs() reports its own errors
                                void closeDocumentTabs(paneTabCloseFamily(tab.id, mode));
                            }}
                        >
                            {
                                {
                                    one: 'Close',
                                    others: 'Close Others',
                                    right: 'Close to the Right',
                                    all: 'Close All',
                                }[mode]
                            }
                        </ContextMenuItem>
                    ))}
                    <ContextMenuSeparator />
                    {(['left', 'right', 'up', 'down'] as const).map((side) => (
                        <ContextMenuItem
                            key={side}
                            onClick={() => splitPaneTab(tab.id, paneId, side)}
                        >
                            {
                                {
                                    left: 'Split Left',
                                    right: 'Split Right',
                                    up: 'Split Up',
                                    down: 'Split Down',
                                }[side]
                            }
                        </ContextMenuItem>
                    ))}
                </ContextMenuContent>
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
    const terminal = useTerminal(terminalId ?? '');
    if (properties.tab.resource.kind === 'terminal')
        return terminal ? <TerminalPaneTab {...properties} terminal={terminal} /> : null;
    return <DocumentPaneTab {...properties} path={properties.tab.resource.path} />;
}

/**
 * One pane's own tab bar. Every pane has one, split or not, and the bar never branches on what its tabs hold: the two
 * tab components differ only in what they render inside the same `WorkTab`.
 */
export function PaneTabBar({
    isOnlySessionTerminal,
    isRootBar,
    pane,
    paneLabel,
}: {
    isOnlySessionTerminal: boolean;
    isRootBar: boolean;
    pane: PaneNode;
    paneLabel: string;
}) {
    const isSidebarVisible = usePanelLayoutStore((state) => state.sidebarVisible);
    const [isDropTarget, setIsDropTarget] = useState(false);
    const barReference = useRef<HTMLDivElement>(null);
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
         * Terminal activation normally moves focus into xterm. This marker exists only for keyboard navigation and is
         * removed on blur, so the Terminal process effect can preserve the WAI-ARIA tab focus without changing mouse
         * selection behavior.
         */
        if (targetTab) {
            const tab = pane.tabs.find((candidate) => candidate.id === target);
            if (tab?.resource.kind === 'terminal') targetTab.dataset.preserveTerminalFocus = 'true';
            targetTab.focus();
        }
        selectPaneTab(target);
    };
    return (
        <div
            className={cn(
                'work-tabs flex h-11 flex-none bg-surface',
                // Only the Workbench-level bar carries the frameless window's drag region and the traffic-light inset;
                // a pane bar inside a split is an ordinary surface.
                isRootBar && '[-webkit-app-region:drag]',
                isRootBar && !isSidebarVisible && 'pl-[78px]',
                isDropTarget && 'bg-elevated',
            )}
            data-pane-tab-bar={pane.id}
            onDragEnter={(event) => {
                if (!canAcceptDrop(event)) return;
                event.preventDefault();
                setIsDropTarget(true);
            }}
            onDragLeave={(event) => {
                if (!event.currentTarget.contains(event.relatedTarget as Node | null))
                    setIsDropTarget(false);
            }}
            onDragOver={(event) => {
                if (!canAcceptDrop(event)) return;
                event.preventDefault();
                event.dataTransfer.dropEffect = 'move';
            }}
            onDrop={(event) => {
                setIsDropTarget(false);
                const tabId = event.dataTransfer.getData(PANE_TAB_DRAG_TYPE);
                if (!tabId) return;
                event.preventDefault();
                movePaneTab(tabId, pane.id);
            }}
        >
            <div ref={barReference} className="work-tab-scroll flex min-w-0 flex-1 overflow-x-auto">
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
                                    tab={tab}
                                />
                            ))}
                        </AnimatePresence>
                    </LazyMotion>
                </div>
            </div>
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
            {/* Evenly divided tabs would otherwise reach the window's right edge and leave this frameless window with
                no draggable chrome at all. This reserved gap inherits the bar's drag region and is the only remaining
                way to move the window by its title area. */}
            {isRootBar && (
                <div aria-hidden="true" className="work-tabs-drag-handle h-11 w-18 flex-none" />
            )}
        </div>
    );
}
