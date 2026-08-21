import {
    Fragment,
    useCallback,
    useEffect,
    useLayoutEffect,
    useMemo,
    useRef,
    useState,
} from 'react';

import { pathBasename } from '@caxri/utils';
import { agentTranscriptTabLabel, parseAgentTranscriptTab } from '@shared/agent-transcript';
import { findPathGroupId, sessionEditorLayout } from '@shared/editor-layout';
import { gitDiffTabLabel, parseGitDiffTab } from '@shared/git-diff';
import { terminalTabLabel } from '@shared/terminal-title';
import type { TerminalRecord } from '@shared/types';
import type { WorkItem } from '@shared/work-item';
import { areWorkItemsEqual, workItemKey } from '@shared/work-item';
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
import {
    useSelectedSession,
    useSessionIds,
    useSessionState,
    useSessionTerminals,
    useTerminal,
} from '../../stores/selectors';
import { sessionViewScope, useActiveWork, useSessionViewStore } from '../../stores/session-view';
import {
    closeAllEditors,
    closeEditor,
    closeEditorsToRight,
    closeOtherEditors,
    pinEditorTab,
    selectEditorTab,
} from '../editor/document-actions';
import { encodeEditorDragPayload } from '../editor/editor-drop-zone';
import { EDITOR_DRAG_TYPE, splitEditorTabTo } from '../editor/editor-layout-actions';
import { moveTerminalToNewSession } from '../session/session-actions';
import {
    sessionActivityPresentation,
    sessionToneBackgroundClassName,
} from '../sidebar/session-activity';
import {
    activateTerminal,
    closeTerminal,
    createTerminal,
    TERMINAL_DRAG_TYPE,
} from '../terminal/terminal-actions';
import {
    retainTerminalProgress,
    terminalProgressAriaLabel,
    terminalProgressLabel,
    useTerminalProgress,
} from '../terminal/terminal-progress';
import type { EditorTabMotionState } from './editor-tab-motion';
import { pruneEditorTabMotionStates, reconcileEditorTabMotion } from './editor-tab-motion';
import { WorkTab } from './work-tab';
import type { WorkTabNavigationKey } from './work-tab-accessibility';
import { workTabId, workTabNavigationTarget } from './work-tab-accessibility';

/**
 * Agent activity for the Terminal that owns the selected Session's title, or `undefined` for a Shell and for a
 * secondary Agent Terminal whose activity the Session read model does not track.
 *
 * Process state answers "is the PTY alive"; this answers "is the Agent waiting for me", which is the only Terminal
 * state worth switching tabs for. Reuses the Sidebar's tone table so one Session never wears two different colors for
 * the same state in two places.
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

function TerminalWorkTab({
    active,
    isOnlyWorkTab,
    onNavigate,
    onSelect,
    tabId,
    terminal,
}: {
    active: boolean;
    isOnlyWorkTab: boolean;
    onNavigate: (key: WorkTabNavigationKey) => void;
    onSelect: () => void;
    tabId: string;
    terminal: TerminalRecord;
}) {
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
            fill
            icon={terminal.kind}
            label={terminalTabLabel(terminal.title)}
            labelTooltip={terminal.title}
            status={terminal.lastProcessState}
            statusActivity={activity}
            tabId={tabId}
            terminalId={terminal.id}
            onClose={() => closeTerminal(terminal.id)}
            onDragStart={(event) => {
                event.dataTransfer.effectAllowed = 'move';
                event.dataTransfer.setData(TERMINAL_DRAG_TYPE, terminal.id);
                event.dataTransfer.setData('text/plain', terminal.id);
            }}
            onKeyDown={(event) => {
                if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
                event.preventDefault();
                onNavigate(event.key as WorkTabNavigationKey);
            }}
            onSelect={onSelect}
            contextMenu={
                <ContextMenuContent>
                    <ContextMenuItem
                        disabledReason={
                            isOnlyWorkTab ? 'This is the only tab open in this session' : undefined
                        }
                        disabled={isOnlyWorkTab}
                        onClick={() => moveTerminalToNewSession(terminal.id, isOnlyWorkTab)}
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
function EditorWorkTab({
    active,
    motionIdentity,
    onNavigate,
    onSelect,
    path,
    preview,
    tabId,
}: {
    active: boolean;
    motionIdentity: string;
    onNavigate: (key: WorkTabNavigationKey) => void;
    onSelect: () => void;
    path: string;
    preview?: true;
    tabId: string;
}) {
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
    const sessionState = useSessionState();
    const openTabs = sessionState?.openTabs ?? [];
    const index = openTabs.findIndex((tab) => tab.path === path);
    const groupId = sessionState
        ? findPathGroupId(sessionEditorLayout(sessionState), path)
        : undefined;
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
            motionIdentity={motionIdentity}
            tabId={tabId}
            onDoubleClick={() => pinEditorTab(path)}
            onClose={() => {
                // eslint-disable-next-line no-void -- intentional floating-promise discard, closeEditor() reports its own errors
                void closeEditor(path);
            }}
            onDragStart={(event) => {
                event.dataTransfer.effectAllowed = 'move';
                event.dataTransfer.setData(
                    EDITOR_DRAG_TYPE,
                    encodeEditorDragPayload({ path, sourceGroupId: groupId }),
                );
                event.dataTransfer.setData('text/plain', path);
            }}
            onKeyDown={(event) => {
                if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
                event.preventDefault();
                onNavigate(event.key as WorkTabNavigationKey);
            }}
            onSelect={onSelect}
            contextMenu={
                <ContextMenuContent>
                    <ContextMenuItem
                        onClick={() => {
                            // eslint-disable-next-line no-void -- intentional floating-promise discard, closeEditor() reports its own errors
                            void closeEditor(path);
                        }}
                    >
                        Close
                    </ContextMenuItem>
                    <ContextMenuSeparator />
                    <ContextMenuItem
                        disabled={openTabs.length < 2}
                        onClick={() => {
                            // eslint-disable-next-line no-void -- intentional floating-promise discard, closeOtherEditors() reports its own errors
                            void closeOtherEditors(path);
                        }}
                    >
                        Close Others
                    </ContextMenuItem>
                    <ContextMenuItem
                        disabled={index === -1 || index === openTabs.length - 1}
                        onClick={() => {
                            // eslint-disable-next-line no-void -- intentional floating-promise discard, closeEditorsToRight() reports its own errors
                            void closeEditorsToRight(path);
                        }}
                    >
                        Close to the Right
                    </ContextMenuItem>
                    <ContextMenuItem
                        onClick={() => {
                            // eslint-disable-next-line no-void -- intentional floating-promise discard, closeAllEditors() reports its own errors
                            void closeAllEditors(path);
                        }}
                    >
                        Close All
                    </ContextMenuItem>
                    <ContextMenuSeparator />
                    <ContextMenuItem
                        disabled={!groupId}
                        onClick={() => groupId && splitEditorTabTo(path, groupId, 'left')}
                    >
                        Split Left
                    </ContextMenuItem>
                    <ContextMenuItem
                        disabled={!groupId}
                        onClick={() => groupId && splitEditorTabTo(path, groupId, 'right')}
                    >
                        Split Right
                    </ContextMenuItem>
                    <ContextMenuItem
                        disabled={!groupId}
                        onClick={() => groupId && splitEditorTabTo(path, groupId, 'up')}
                    >
                        Split Up
                    </ContextMenuItem>
                    <ContextMenuItem
                        disabled={!groupId}
                        onClick={() => groupId && splitEditorTabTo(path, groupId, 'down')}
                    >
                        Split Down
                    </ContextMenuItem>
                </ContextMenuContent>
            }
            preview={preview}
        />
    );
}

function isActive(activeWork: WorkItem | undefined, item: WorkItem): boolean {
    return areWorkItemsEqual(activeWork, item);
}

type WorkTabItem =
    | { item: WorkItem; kind: 'editor'; motionKey: string; path: string; preview?: true }
    | { item: WorkItem; kind: 'terminal'; motionKey: string; terminal: TerminalRecord };

export function WorkTabStrip() {
    const sessionTerminals = useSessionTerminals();
    const openTabs = useSessionState()?.openTabs;
    const selectedSessionId = useSelectedSession()?.id;
    const sessionIds = useSessionIds();
    const activeWork = useActiveWork();
    const isSidebarVisible = usePanelLayoutStore((state) => state.sidebarVisible);
    const [editorMotionStates] = useState(() => new Map<string, EditorTabMotionState>());
    const stripReference = useRef<HTMLDivElement>(null);
    const activeWorkKey = workItemKey(activeWork);
    /**
     * `overflow-x-auto` (below) has no built-in cue for "the active tab is off to the side," so selecting or creating a
     * tab that lands outside the visible strip must scroll it into view itself — matching the VS Code norm this strip
     * otherwise follows. `block: 'nearest'` keeps the page from also scrolling vertically to reveal an element that
     * never left the viewport.
     */
    useEffect(() => {
        stripReference.current
            ?.querySelector<HTMLElement>('[data-tab-active="true"]')
            ?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }, [activeWorkKey]);
    useEffect(() => {
        const runningTerminalIds = new Set<string>();
        for (const terminal of sessionTerminals)
            if (terminal.lastProcessState === 'running') runningTerminalIds.add(terminal.id);
        retainTerminalProgress(runningTerminalIds);
    }, [selectedSessionId, sessionTerminals]);
    const editorMotionState = useMemo(
        () =>
            reconcileEditorTabMotion(
                selectedSessionId ? editorMotionStates.get(selectedSessionId) : undefined,
                openTabs ?? [],
            ),
        [editorMotionStates, openTabs, selectedSessionId],
    );
    useLayoutEffect(() => {
        if (selectedSessionId) editorMotionStates.set(selectedSessionId, editorMotionState);
    }, [editorMotionState, editorMotionStates, selectedSessionId]);
    useLayoutEffect(() => {
        pruneEditorTabMotionStates(editorMotionStates, sessionIds);
    }, [editorMotionStates, sessionIds]);
    const items = useMemo<WorkTabItem[]>(
        () => [
            ...sessionTerminals.map((terminal) => ({
                kind: 'terminal' as const,
                item: { kind: 'terminal' as const, terminalId: terminal.id },
                motionKey: `terminal:${terminal.id}`,
                terminal,
            })),
            ...editorMotionState.tabs.map((tab) => ({
                kind: 'editor' as const,
                item: { kind: 'editor' as const, path: tab.path },
                motionKey: `editor:${selectedSessionId}:${tab.motionId}`,
                path: tab.path,
                preview: tab.preview,
            })),
        ],
        [editorMotionState.tabs, selectedSessionId, sessionTerminals],
    );
    const selectWorkItem = useCallback((item: WorkItem) => {
        if (item.kind === 'terminal') activateTerminal(item.terminalId);
        else selectEditorTab(item.path);
    }, []);
    const navigateWorkTabs = useCallback(
        (current: WorkItem, key: WorkTabNavigationKey) => {
            const target = workTabNavigationTarget(
                items.map((item) => item.item),
                current,
                key,
            );
            if (!target || !selectedSessionId) return;
            const targetId = workTabId(selectedSessionId, target);
            const targetTab = document.querySelector<HTMLElement>(`#${CSS.escape(targetId)}`);
            if (targetTab && stripReference.current?.contains(targetTab)) {
                /**
                 * Terminal activation normally moves focus into xterm. This marker exists only for keyboard navigation
                 * and is removed on blur, so the Terminal process effect can preserve the WAI-ARIA tab focus without
                 * changing mouse selection behavior.
                 */
                if (target.kind === 'terminal') targetTab.dataset.preserveTerminalFocus = 'true';
                targetTab.focus();
            }
            selectWorkItem(target);
        },
        [items, selectedSessionId, selectWorkItem],
    );
    return (
        <div
            className={cn(
                'work-tabs flex h-11 bg-surface [-webkit-app-region:drag]',
                !isSidebarVisible && 'pl-[78px]',
            )}
        >
            <div
                ref={stripReference}
                className="work-tab-scroll flex min-w-0 flex-1 overflow-x-auto"
            >
                <div
                    /**
                     * `min-w-full` (not `w-full`) lets evenly divided Terminal tabs claim the whole rail while still
                     * allowing the list to grow past it once enough tabs hit their minimum width, which is what hands
                     * overflow back to the scroll container above.
                     */
                    className="work-tab-list flex h-11 min-w-full items-stretch"
                    role="tablist"
                    aria-label="Open work"
                    aria-orientation="horizontal"
                >
                    <LazyMotion strict features={domAnimation}>
                        {/* Keying this Fragment by Session remounts the whole subtree on Session switch:
                        the fresh mount renders without enter keyframes (AnimatePresence's
                        `initial={false}` only suppresses animation on first render of a subtree), and
                        the previous subtree unmounts without exit keyframes. This replaces the old
                        sessionIdRef-based "skip animation once" logic. */}
                        <Fragment key={selectedSessionId}>
                            <AnimatePresence initial={false}>
                                {items.map((item) =>
                                    item.kind === 'terminal' ? (
                                        <TerminalWorkTab
                                            key={item.motionKey}
                                            active={isActive(activeWork, item.item)}
                                            isOnlyWorkTab={items.length === 1}
                                            onNavigate={(key) => navigateWorkTabs(item.item, key)}
                                            onSelect={() => selectWorkItem(item.item)}
                                            tabId={
                                                selectedSessionId
                                                    ? workTabId(selectedSessionId, item.item)
                                                    : ''
                                            }
                                            terminal={item.terminal}
                                        />
                                    ) : (
                                        <EditorWorkTab
                                            key={item.motionKey}
                                            active={isActive(activeWork, item.item)}
                                            motionIdentity={item.motionKey}
                                            onNavigate={(key) => navigateWorkTabs(item.item, key)}
                                            onSelect={() => selectWorkItem(item.item)}
                                            path={item.path}
                                            preview={item.preview}
                                            tabId={
                                                selectedSessionId
                                                    ? workTabId(selectedSessionId, item.item)
                                                    : ''
                                            }
                                        />
                                    ),
                                )}
                            </AnimatePresence>
                        </Fragment>
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
                            void createTerminal('shell');
                        }}
                    >
                        <Plus size={14} />
                    </Button>
                </CommandTooltip>
            </div>
            {/* Evenly divided Terminal tabs would otherwise reach the window's right edge and leave this frameless
                window with no draggable chrome at all. This reserved gap inherits the strip's drag region and is the
                only remaining way to move the window by its title area. */}
            <div aria-hidden="true" className="work-tabs-drag-handle h-11 w-18 flex-none" />
        </div>
    );
}
