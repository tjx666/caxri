import { Plus, SplitSquareVertical } from 'lucide-react';

import type { TerminalRecord } from '@shared/types';
import { workItemsEqual, type WorkItem } from '@shared/work-item';

import { Button } from '../../components/ui/button';
import { useSelectedSession, useSessionState, useSessionTerminals } from '../../state/selectors';
import { useActiveWork, useSessionViewStore } from '../../state/session-view';
import { closeEditor, selectEditorTab } from '../editor/document-actions';
import { activateTerminal, closeTerminal, createTerminal } from '../terminal/terminal-actions';
import { TERMINAL_DRAG_TYPE } from '../terminal/terminal-view-commands';
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
function EditorWorkTab({ active, path }: { active: boolean; path: string }) {
    const sessionId = useSelectedSession()?.id;
    const dirty = useSessionViewStore((state) =>
        sessionId ? Boolean(state.documents[sessionId]?.[path]?.dirty) : false,
    );
    return (
        <WorkTab
            active={active}
            closeLabel="Close Editor"
            dirty={dirty}
            icon="file"
            label={fileName(path)}
            onClose={() => closeEditor(path)}
            onSelect={() => selectEditorTab(path)}
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
    return (
        <div className="work-tabs" role="tablist" aria-label="Open work">
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
                />
            ))}
            <div className="tab-actions">
                <Button
                    size="icon"
                    variant="ghost"
                    title="New Terminal"
                    onClick={() => void createTerminal('shell')}
                >
                    <Plus size={14} />
                </Button>
                <Button
                    size="icon"
                    variant="ghost"
                    title="Split Terminal"
                    onClick={() => void createTerminal('shell', true)}
                >
                    <SplitSquareVertical size={14} />
                </Button>
            </div>
        </div>
    );
}
