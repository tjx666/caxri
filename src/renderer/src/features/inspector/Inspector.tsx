import { Files, GitBranch, Info } from 'lucide-react';

import type { InspectorMode } from '@shared/types';

import { executeCommand } from '../../commands/execute';
import { useSelectedSession, useSessionState } from '../../state/selectors';
import { FileTreePanel } from './FileTreePanel';
import { GitPanel } from './GitPanel';
import { TerminalInfoPanel } from './TerminalInfoPanel';

/** Mode changes go through the command table so the palette, shortcuts, and tabs share one path. */
const inspectorCommands: Record<InspectorMode, string> = {
    files: 'inspector.showFiles',
    git: 'inspector.showGit',
    info: 'inspector.showInfo',
};

const tabs: Array<{ id: InspectorMode; label: string; icon: typeof Files }> = [
    { id: 'files', label: 'Files', icon: Files },
    { id: 'git', label: 'Git', icon: GitBranch },
    { id: 'info', label: 'Info', icon: Info },
];

export function Inspector() {
    const sessionId = useSelectedSession()?.id;
    const mode = useSessionState()?.inspectorMode ?? 'files';
    return (
        <aside className="inspector">
            <div className="inspector-tabs">
                {tabs.map(({ id, label, icon: Icon }) => (
                    <button
                        key={id}
                        className={mode === id ? 'active' : ''}
                        title={label}
                        onClick={() => executeCommand(inspectorCommands[id])}
                    >
                        <Icon size={15} />
                        <span>{label}</span>
                    </button>
                ))}
            </div>
            {mode === 'files' && <FileTreePanel />}
            {mode === 'git' && <GitPanel key={sessionId} />}
            {mode === 'info' && <TerminalInfoPanel />}
        </aside>
    );
}
