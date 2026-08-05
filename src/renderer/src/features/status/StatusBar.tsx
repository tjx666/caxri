import { PanelRight } from 'lucide-react';

import type { BootstrapState } from '@shared/types';

import { executeCommand } from '../../commands/execute';
import { usePanelLayoutStore } from '../../state/panel-layout';
import { useSelectedSession, useSessionTerminals } from '../../state/selectors';
import { useWorkbenchStore } from '../../state/workbench';

type RuntimeStatus = BootstrapState['runtime']['status'];

/**
 * A healthy backend says nothing: the status bar only speaks up while Caxri is degraded, and it
 * does so in the user's vocabulary rather than naming the Runtime process.
 */
const DEGRADED_STATES: Partial<Record<RuntimeStatus, { label: string; className: string }>> = {
    /** No imperative "Restart" here: recovery is offered by the native Relaunch dialog, not the chip. */
    failed: { label: 'Backend stopped', className: 'statusbar-state-danger' },
    restarting: { label: 'Reconnecting…', className: 'statusbar-state-warning' },
};

export function StatusBar() {
    const rootPath = useSelectedSession()?.rootPath;
    const runtimeStatus = useWorkbenchStore((state) => state.bootstrap?.runtime.status);
    const degraded = runtimeStatus ? DEGRADED_STATES[runtimeStatus] : undefined;
    const runningCount = useSessionTerminals().filter(
        (terminal) => terminal.lastProcessState === 'running',
    ).length;
    const inspectorVisible = usePanelLayoutStore((state) => state.inspectorVisible);
    const toggleLabel = inspectorVisible ? 'Hide Inspector' : 'Show Inspector';
    return (
        /**
         * `data-runtime-status` is the stable readiness signal: it is present in every visual
         * state, including the healthy one that renders no chip at all.
         */
        <footer className="statusbar" data-runtime-status={runtimeStatus ?? 'starting'}>
            <span className="statusbar-path">{rootPath ?? 'No Session selected'}</span>
            {degraded && (
                <span className={`statusbar-state ${degraded.className}`}>{degraded.label}</span>
            )}
            <span className="statusbar-count">{runningCount} running</span>
            <button
                type="button"
                className="statusbar-toggle"
                aria-pressed={inspectorVisible}
                aria-label={toggleLabel}
                title={toggleLabel}
                onClick={() => executeCommand('inspector.toggle')}
            >
                <PanelRight size={12} />
            </button>
        </footer>
    );
}
