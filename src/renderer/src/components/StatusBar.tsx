import { PanelRight } from 'lucide-react';

import type { BootstrapState } from '@shared/types';

interface StatusBarProps {
    rootPath?: string;
    runningCount: number;
    runtimeStatus: BootstrapState['runtime']['status'];
}

export function StatusBar({ rootPath, runningCount, runtimeStatus }: StatusBarProps) {
    return (
        <footer className="statusbar">
            <span>{runtimeStatus === 'ready' ? 'Runtime ready' : `Runtime ${runtimeStatus}`}</span>
            <span>{rootPath ?? 'No Session selected'}</span>
            <span>{runningCount} running</span>
            <PanelRight size={12} />
        </footer>
    );
}
