import { Activity, Files, GitBranch, Info } from 'lucide-react';

import type { InspectorMode } from '@shared/types';

import { executeCommand } from '../../commands/execute';
import { cn } from '../../lib/utils';
import { useSelectedSession, useSessionState } from '../../state/selectors';
import { FileTreePanel } from './FileTreePanel';
import { GitPanel } from './GitPanel';
import { ProjectStatusPanel } from './ProjectStatusPanel';
import { TerminalInfoPanel } from './TerminalInfoPanel';

/** Mode changes go through the command table so the palette, shortcuts, and tabs share one path. */
const inspectorCommands: Record<InspectorMode, string> = {
    files: 'inspector.showFiles',
    git: 'inspector.showGit',
    status: 'inspector.showStatus',
    info: 'inspector.showInfo',
};

const tabs: Array<{ id: InspectorMode; label: string; icon: typeof Files }> = [
    { id: 'files', label: 'Files', icon: Files },
    { id: 'git', label: 'Git', icon: GitBranch },
    { id: 'status', label: 'Status', icon: Activity },
    { id: 'info', label: 'Info', icon: Info },
];

export function Inspector() {
    const sessionId = useSelectedSession()?.id;
    const mode = useSessionState()?.inspectorMode ?? 'files';
    return (
        <aside className="inspector min-w-0 flex min-h-0 flex-col bg-surface">
            <div className="inspector-tabs grid grid-cols-4 min-h-9 border-b border-border">
                {tabs.map(({ id, label, icon: Icon }) => (
                    <button
                        key={id}
                        className={cn(
                            'flex items-center justify-center gap-1 border-0 border-b-2 border-transparent bg-surface text-muted text-[11px] cursor-pointer hover:text-foreground',
                            mode === id && 'active border-indicator text-foreground',
                        )}
                        title={label}
                        onClick={() => executeCommand(inspectorCommands[id])}
                    >
                        <Icon size={15} />
                        <span className="max-[1100px]:hidden">{label}</span>
                    </button>
                ))}
            </div>
            {mode === 'files' && <FileTreePanel />}
            {mode === 'git' && <GitPanel key={sessionId} />}
            {mode === 'status' && <ProjectStatusPanel key={sessionId} />}
            {mode === 'info' && <TerminalInfoPanel />}
        </aside>
    );
}
