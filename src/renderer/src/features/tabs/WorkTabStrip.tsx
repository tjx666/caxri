import { CircleAlert, LoaderCircle, Pause, Plus } from 'lucide-react';
import { AnimatePresence, LazyMotion, domAnimation } from 'motion/react';
import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

import type { TerminalRecord } from '@shared/types';
import { gitDiffTabLabel, parseGitDiffTab } from '@shared/git-diff';
import { workItemKey, workItemsEqual, type WorkItem } from '@shared/work-item';

import { Button } from '../../components/ui/button';
import { CommandTooltip } from '../../components/ui/tooltip';
import {
    ContextMenuContent,
    ContextMenuItem,
    ContextMenuSeparator,
} from '../../components/ui/context-menu';
import {
    useSelectedSession,
    useSessionIds,
    useSessionState,
    useSessionTerminals,
} from '../../stores/selectors';
import { usePanelLayoutStore } from '../../stores/panel-layout';
import { sessionViewScope, useActiveWork, useSessionViewStore } from '../../stores/session-view';
import { cn } from '../../lib/utils';
import {
    closeAllEditors,
    closeEditor,
    closeEditorsToRight,
    closeOtherEditors,
    pinEditorTab,
    selectEditorTab,
} from '../editor/document-actions';
import {
    activateTerminal,
    closeTerminal,
    createTerminal,
    TERMINAL_DRAG_TYPE,
} from '../terminal/terminal-actions';
import {
    terminalProgressAriaLabel,
    terminalProgressLabel,
    retainTerminalProgress,
    useTerminalProgress,
} from '../terminal/terminal-progress';
import { WorkTab } from './WorkTab';
import {
    pruneEditorTabMotionStates,
    reconcileEditorTabMotion,
    type EditorTabMotionState,
} from './editor-tab-motion';

const fileName = (path: string): string => path.split('/').filter(Boolean).at(-1) ?? path;

function TerminalWorkTab({ active, terminal }: { active: boolean; terminal: TerminalRecord }) {
    const progress = useTerminalProgress(terminal.id);
    const ProgressIcon =
        progress?.kind === 'error'
            ? CircleAlert
            : progress?.kind === 'paused'
              ? Pause
              : progress?.kind === 'indeterminate'
                ? LoaderCircle
                : undefined;
    return (
        <WorkTab
            active={active}
            accessory={
                progress && (
                    <span
                        aria-label={terminalProgressAriaLabel(progress)}
                        className={cn(
                            'terminal-progress-tab inline-flex flex-none items-center gap-1 tabular-nums',
                            /**
                             * `--accent` marks exactly one thing at a time — the focused pane/tab
                             * (DESIGN.md principle 2). This badge renders on every tab with
                             * progress, active or not, so a background `npm install` must not
                             * wear the same accent color the focused tab's ring already owns.
                             */
                            progress.kind === 'normal' && 'text-muted',
                            progress.kind === 'error' && 'text-danger',
                            progress.kind === 'paused' && 'text-warning',
                        )}
                        data-terminal-progress-state={progress.kind}
                        title={terminalProgressAriaLabel(progress)}
                    >
                        {ProgressIcon && (
                            <ProgressIcon
                                aria-hidden="true"
                                className={cn(
                                    progress.kind === 'indeterminate' &&
                                        'animate-spin motion-reduce:animate-none',
                                )}
                                size={11}
                            />
                        )}
                        {progress.kind !== 'indeterminate' && terminalProgressLabel(progress)}
                    </span>
                )
            }
            closeLabel="Close Terminal"
            icon={terminal.kind}
            label={terminal.title}
            status={terminal.lastProcessState}
            terminalId={terminal.id}
            onClose={() => closeTerminal(terminal.id)}
            onDragStart={(event) => {
                event.dataTransfer.effectAllowed = 'move';
                event.dataTransfer.setData(TERMINAL_DRAG_TYPE, terminal.id);
                event.dataTransfer.setData('text/plain', terminal.id);
            }}
            onSelect={() => activateTerminal(terminal.id)}
        />
    );
}

/** Subscribes to its own document so a keystroke only rerenders the tab whose dirty flag flipped. */
function EditorWorkTab({
    active,
    motionIdentity,
    path,
    preview,
}: {
    active: boolean;
    motionIdentity: string;
    path: string;
    preview?: true;
}) {
    const session = useSelectedSession();
    const gitDiffTab = parseGitDiffTab(path);
    const dirty = useSessionViewStore((state) =>
        session
            ? Boolean(
                  state.documents[sessionViewScope(session.id, session.workbenchProjectId)]?.[path]
                      ?.dirty,
              )
            : false,
    );
    const openTabs = useSessionState()?.openTabs ?? [];
    const index = openTabs.findIndex((tab) => tab.path === path);
    return (
        <WorkTab
            active={active}
            closeLabel="Close Editor"
            dirty={dirty}
            fileIconName={
                gitDiffTab?.kind === 'file'
                    ? fileName(gitDiffTab.path)
                    : gitDiffTab?.kind === 'changes'
                      ? 'changes.diff'
                      : fileName(path)
            }
            icon="file"
            label={gitDiffTab ? gitDiffTabLabel(gitDiffTab) : fileName(path)}
            motionIdentity={motionIdentity}
            onDoubleClick={() => pinEditorTab(path)}
            onClose={() => void closeEditor(path)}
            onSelect={() => selectEditorTab(path)}
            contextMenu={
                <ContextMenuContent>
                    <ContextMenuItem onClick={() => void closeEditor(path)}>Close</ContextMenuItem>
                    <ContextMenuSeparator />
                    <ContextMenuItem
                        disabled={openTabs.length < 2}
                        onClick={() => void closeOtherEditors(path)}
                    >
                        Close Others
                    </ContextMenuItem>
                    <ContextMenuItem
                        disabled={index < 0 || index === openTabs.length - 1}
                        onClick={() => void closeEditorsToRight(path)}
                    >
                        Close to the Right
                    </ContextMenuItem>
                    <ContextMenuItem onClick={() => void closeAllEditors(path)}>
                        Close All
                    </ContextMenuItem>
                </ContextMenuContent>
            }
            preview={preview}
        />
    );
}

function isActive(activeWork: WorkItem | undefined, item: WorkItem): boolean {
    return workItemsEqual(activeWork, item);
}

type WorkTabItem =
    | { kind: 'editor'; motionKey: string; path: string; preview?: true }
    | { kind: 'terminal'; motionKey: string; terminal: TerminalRecord };

export function WorkTabStrip() {
    const sessionTerminals = useSessionTerminals();
    const openTabs = useSessionState()?.openTabs;
    const selectedSessionId = useSelectedSession()?.id;
    const sessionIds = useSessionIds();
    const activeWork = useActiveWork();
    const sidebarVisible = usePanelLayoutStore((state) => state.sidebarVisible);
    const [editorMotionStates] = useState(() => new Map<string, EditorTabMotionState>());
    const stripRef = useRef<HTMLDivElement>(null);
    const activeWorkKey = workItemKey(activeWork);
    /**
     * `overflow-x-auto` (below) has no built-in cue for "the active tab is off to the side," so
     * selecting or creating a tab that lands outside the visible strip must scroll it into view
     * itself — matching the VS Code norm this strip otherwise follows. `block: 'nearest'` keeps
     * the page from also scrolling vertically to reveal an element that never left the viewport.
     */
    useEffect(() => {
        stripRef.current
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
                motionKey: `terminal:${terminal.id}`,
                terminal,
            })),
            ...editorMotionState.tabs.map((tab) => ({
                kind: 'editor' as const,
                motionKey: `editor:${selectedSessionId}:${tab.motionId}`,
                path: tab.path,
                preview: tab.preview,
            })),
        ],
        [editorMotionState.tabs, selectedSessionId, sessionTerminals],
    );
    return (
        <div
            ref={stripRef}
            className={cn(
                'work-tabs flex h-11 items-end overflow-x-auto border-b border-border bg-surface [-webkit-app-region:drag] [&>.work-tab]:h-9',
                !sidebarVisible && 'pl-[78px]',
            )}
            role="tablist"
            aria-label="Open work"
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
                                    active={isActive(activeWork, {
                                        kind: 'terminal',
                                        terminalId: item.terminal.id,
                                    })}
                                    terminal={item.terminal}
                                />
                            ) : (
                                <EditorWorkTab
                                    key={item.motionKey}
                                    active={isActive(activeWork, {
                                        kind: 'editor',
                                        path: item.path,
                                    })}
                                    motionIdentity={item.motionKey}
                                    path={item.path}
                                    preview={item.preview}
                                />
                            ),
                        )}
                    </AnimatePresence>
                </Fragment>
            </LazyMotion>
            <div className="tab-actions flex h-9 flex-none items-center px-1 bg-surface [-webkit-app-region:no-drag]">
                <CommandTooltip commandId="terminal.new">
                    <Button
                        size="icon"
                        variant="ghost"
                        aria-label="New Terminal"
                        onClick={() => void createTerminal('shell')}
                    >
                        <Plus size={14} />
                    </Button>
                </CommandTooltip>
            </div>
        </div>
    );
}
