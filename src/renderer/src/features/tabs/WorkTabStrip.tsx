import { Plus } from 'lucide-react';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

import type { TerminalRecord } from '@shared/types';
import { gitDiffTabLabel, parseGitDiffTab } from '@shared/git-diff';
import { workItemsEqual, type WorkItem } from '@shared/work-item';

import { Button } from '../../components/ui/button';
import { CommandTooltip } from '../../components/ui/tooltip';
import {
    ContextMenuContent,
    ContextMenuItem,
    ContextMenuSeparator,
} from '../../components/ui/context-menu';
import { useSelectedSession, useSessionState, useSessionTerminals } from '../../stores/selectors';
import { usePanelLayoutStore } from '../../stores/panel-layout';
import { useActiveWork, useSessionViewStore } from '../../stores/session-view';
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
import { WorkTab } from './WorkTab';
import {
    finishWorkTabMotion,
    reconcileWorkTabMotion,
    type WorkTabMotionItem,
    type WorkTabMotionPhase,
} from './work-tab-motion';

const fileName = (path: string): string => path.split('/').filter(Boolean).at(-1) ?? path;

function TerminalWorkTab({
    active,
    motionPhase,
    onMotionEnd,
    terminal,
}: {
    active: boolean;
    motionPhase: WorkTabMotionPhase;
    onMotionEnd: () => void;
    terminal: TerminalRecord;
}) {
    return (
        <WorkTab
            active={active}
            closeLabel="Close Terminal"
            icon={terminal.kind}
            label={terminal.title}
            motionPhase={motionPhase}
            status={terminal.lastProcessState}
            terminalId={terminal.id}
            onClose={() => closeTerminal(terminal.id)}
            onDragStart={(event) => {
                event.dataTransfer.effectAllowed = 'move';
                event.dataTransfer.setData(TERMINAL_DRAG_TYPE, terminal.id);
                event.dataTransfer.setData('text/plain', terminal.id);
            }}
            onMotionEnd={onMotionEnd}
            onSelect={() => activateTerminal(terminal.id)}
        />
    );
}

/** Subscribes to its own document so a keystroke only rerenders the tab whose dirty flag flipped. */
function EditorWorkTab({
    active,
    path,
    preview,
    motionPhase,
    onMotionEnd,
}: {
    active: boolean;
    motionPhase: WorkTabMotionPhase;
    onMotionEnd: () => void;
    path: string;
    preview?: true;
}) {
    const sessionId = useSelectedSession()?.id;
    const gitDiffTab = parseGitDiffTab(path);
    const dirty = useSessionViewStore((state) =>
        sessionId ? Boolean(state.documents[sessionId]?.[path]?.dirty) : false,
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
            motionPhase={motionPhase}
            onDoubleClick={() => pinEditorTab(path)}
            onMotionEnd={onMotionEnd}
            onClose={() => closeEditor(path)}
            onSelect={() => selectEditorTab(path)}
            contextMenu={
                <ContextMenuContent>
                    <ContextMenuItem onClick={() => closeEditor(path)}>Close</ContextMenuItem>
                    <ContextMenuSeparator />
                    <ContextMenuItem
                        disabled={openTabs.length < 2}
                        onClick={() => closeOtherEditors(path)}
                    >
                        Close Others
                    </ContextMenuItem>
                    <ContextMenuItem
                        disabled={index < 0 || index === openTabs.length - 1}
                        onClick={() => closeEditorsToRight(path)}
                    >
                        Close to the Right
                    </ContextMenuItem>
                    <ContextMenuItem onClick={() => closeAllEditors(path)}>
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

function usePrefersReducedMotion(): boolean {
    const [reduced, setReduced] = useState(
        () => window.matchMedia('(prefers-reduced-motion: reduce)').matches,
    );
    useEffect(() => {
        const media = window.matchMedia('(prefers-reduced-motion: reduce)');
        const update = (): void => setReduced(media.matches);
        media.addEventListener('change', update);
        return () => media.removeEventListener('change', update);
    }, []);
    return reduced;
}

function useWorkTabMotion(items: WorkTabItem[], sessionId: string | undefined) {
    const reducedMotion = usePrefersReducedMotion();
    const sessionIdRef = useRef(sessionId);
    const [rendered, setRendered] = useState<WorkTabMotionItem<WorkTabItem>[]>(() =>
        reconcileWorkTabMotion([], items, false),
    );

    useLayoutEffect(() => {
        const sessionChanged = sessionIdRef.current !== sessionId;
        sessionIdRef.current = sessionId;
        setRendered((current) =>
            reconcileWorkTabMotion(current, items, !sessionChanged && !reducedMotion),
        );
    }, [items, reducedMotion, sessionId]);

    /** Animation events normally settle presence; this bound prevents a hidden window from retaining ghosts. */
    useEffect(() => {
        if (!rendered.some((entry) => entry.phase !== 'stable')) return;
        const timer = window.setTimeout(() => {
            setRendered((current) =>
                current.flatMap((entry) =>
                    entry.phase === 'exit' ? [] : [{ ...entry, phase: 'stable' }],
                ),
            );
        }, 220);
        return () => window.clearTimeout(timer);
    }, [rendered]);

    return {
        finish: (motionKey: string): void => {
            setRendered((current) => finishWorkTabMotion(current, motionKey));
        },
        rendered,
    };
}

export function WorkTabStrip() {
    const sessionTerminals = useSessionTerminals();
    const openTabs = useSessionState()?.openTabs;
    const selectedSessionId = useSelectedSession()?.id;
    const activeWork = useActiveWork();
    const sidebarVisible = usePanelLayoutStore((state) => state.sidebarVisible);
    const items = useMemo<WorkTabItem[]>(
        () => [
            ...sessionTerminals.map((terminal) => ({
                kind: 'terminal' as const,
                motionKey: `terminal:${terminal.id}`,
                terminal,
            })),
            ...(openTabs ?? []).map((tab) => ({
                kind: 'editor' as const,
                motionKey: `editor:${tab.path}`,
                path: tab.path,
                preview: tab.preview,
            })),
        ],
        [openTabs, sessionTerminals],
    );
    const motion = useWorkTabMotion(items, selectedSessionId);
    return (
        <div
            className={cn(
                'work-tabs flex h-11 items-end overflow-x-auto border-b border-border bg-surface [-webkit-app-region:drag] [&>.work-tab]:h-9',
                !sidebarVisible && 'pl-[78px]',
            )}
            role="tablist"
            aria-label="Open work"
        >
            {motion.rendered.map(({ item, phase }) => {
                const onMotionEnd = (): void => motion.finish(item.motionKey);
                return item.kind === 'terminal' ? (
                    <TerminalWorkTab
                        key={item.motionKey}
                        active={
                            phase !== 'exit' &&
                            isActive(activeWork, {
                                kind: 'terminal',
                                terminalId: item.terminal.id,
                            })
                        }
                        motionPhase={phase}
                        onMotionEnd={onMotionEnd}
                        terminal={item.terminal}
                    />
                ) : (
                    <EditorWorkTab
                        key={item.motionKey}
                        active={
                            phase !== 'exit' &&
                            isActive(activeWork, { kind: 'editor', path: item.path })
                        }
                        motionPhase={phase}
                        onMotionEnd={onMotionEnd}
                        path={item.path}
                        preview={item.preview}
                    />
                );
            })}
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
