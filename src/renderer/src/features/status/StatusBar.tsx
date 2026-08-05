import { PanelRight } from 'lucide-react';

import { useSelectedSession, useSessionTerminals } from '../../state/selectors';
import { useWorkbenchStore } from '../../state/workbench';

export function StatusBar() {
    const rootPath = useSelectedSession()?.rootPath;
    const runtimeStatus = useWorkbenchStore((state) => state.bootstrap?.runtime.status);
    const runningCount = useSessionTerminals().filter(
        (terminal) => terminal.lastProcessState === 'running',
    ).length;
    return (
        <footer className="statusbar">
            <span>{runtimeStatus === 'ready' ? 'Runtime ready' : `Runtime ${runtimeStatus}`}</span>
            <span>{rootPath ?? 'No Session selected'}</span>
            <span>{runningCount} running</span>
            <PanelRight size={12} />
        </footer>
    );
}
