import { Plus } from 'lucide-react';

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

const fileName = (path: string): string => path.split('/').filter(Boolean).at(-1) ?? path;

function TerminalWorkTab({ active, terminal }: { active: boolean; terminal: TerminalRecord }) {
    return (
        <WorkTab
            active={active}
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
    path,
    preview,
}: {
    active: boolean;
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
            onDoubleClick={() => pinEditorTab(path)}
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

export function WorkTabStrip() {
    const sessionTerminals = useSessionTerminals();
    const openTabs = useSessionState()?.openTabs;
    const activeWork = useActiveWork();
    const sidebarVisible = usePanelLayoutStore((state) => state.sidebarVisible);
    return (
        <div
            className={cn(
                'work-tabs flex h-11 items-end overflow-x-auto border-b border-border bg-surface [-webkit-app-region:drag] [&>.work-tab]:h-9',
                !sidebarVisible && 'pl-[78px]',
            )}
            role="tablist"
            aria-label="Open work"
        >
            {sessionTerminals.map((terminal) => (
                <TerminalWorkTab
                    key={terminal.id}
                    active={isActive(activeWork, { kind: 'terminal', terminalId: terminal.id })}
                    terminal={terminal}
                />
            ))}
            {openTabs?.map((tab) => (
                <EditorWorkTab
                    key={tab.path}
                    active={isActive(activeWork, { kind: 'editor', path: tab.path })}
                    path={tab.path}
                    preview={tab.preview}
                />
            ))}
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
