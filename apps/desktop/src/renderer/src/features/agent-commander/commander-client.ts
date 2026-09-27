import type { BootstrapState, CommanderIdentity, CommanderSnapshot } from '@caxri/protocol';

import { caxri } from '../../lib/caxri';
import { createStore } from '../../lib/store';
import { useWorkbenchStore } from '../../stores/workbench';

interface AgentCommanderState {
    /**
     * The Commander's system Project, Session, and Terminal, known once `commander.ensure` resolves.
     */
    identity?: CommanderIdentity;
    workspacePath?: string;
}

export const useAgentCommanderStore = createStore<AgentCommanderState>(
    'agent-commander',
    () => ({}),
);

function adoptSnapshot(snapshot: CommanderSnapshot): void {
    useAgentCommanderStore.setState({
        identity: snapshot.identity,
        workspacePath: snapshot.workspacePath,
    });
}

const ensureRequest = { inFlight: undefined as Promise<void> | undefined };

async function runEnsure(): Promise<void> {
    try {
        const snapshot = await caxri.request('commander.ensure');
        adoptSnapshot(snapshot);
        useWorkbenchStore.setState({ bootstrap: snapshot.workbench });
    } finally {
        ensureRequest.inFlight = undefined;
    }
}

/**
 * Creates the Commander on first use and seeds the Workbench store with its scoped snapshot. The Workbench store is
 * what the ordinary Terminal pane reads, so this window reuses that pane unchanged. Main learns the Commander Terminal
 * from this reply before it admits any `terminal.*` request for it, which is why the pane mounts only afterwards.
 *
 * Single-flight: `commander.ensure` launches the Commander Terminal when it creates one, so React StrictMode's double
 * mount must share one request instead of racing two creations.
 */
export function ensureAgentCommander(): Promise<void> {
    ensureRequest.inFlight ??= runEnsure();
    return ensureRequest.inFlight;
}

/**
 * The Workbench store's snapshot source in this window (see `configureWorkbenchSnapshotSource`). Every refresh, whether
 * this window's event bridge asked for it or a shared Terminal command did, reads the Commander-scoped snapshot, which
 * also keeps Main's record of the Commander Terminal current.
 */
export async function readAgentCommanderWorkbench(): Promise<BootstrapState> {
    const snapshot = await caxri.request('commander.snapshot');
    if (!snapshot)
        throw new Error(
            'Agent Commander is no longer set up. Close this window and open it again.',
        );
    adoptSnapshot(snapshot);
    return snapshot.workbench;
}
