import type {
    BootstrapState,
    CommanderBoard,
    CommanderIdentity,
    CommanderSnapshot,
} from '@caxri/protocol';

import { caxri } from '../../lib/caxri';
import { createStore } from '../../lib/store';
import { caxriQueryKey, fetchCaxriQuery, queryClient } from '../../queries/client';
import { useWorkbenchStore } from '../../stores/workbench';
import { patchCommanderBoardPullRequests } from './commander-board';

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

/**
 * Patches the board rows of Sessions whose pull request changed, from one fresh `session.pullRequests` read, instead of
 * refetching the whole board (issue caxri#1411).
 *
 * The Workbench window keeps that snapshot fresh through `useRuntimeQueryInvalidation`, but this window never mounts it
 * (`useAgentCommander` is its only event subscription), so there is no refreshed copy here to reuse and it reads its
 * own. `staleTime: 0` because the event already says the previous answer is out of date. The Server answers from the
 * sweep that emitted the event, so this read does not start another GitHub lookup.
 *
 * A board that has not loaded yet has no rows to patch, and its first read may have been answered before the sweep and
 * still be on its way here, so it is asked to read again instead; that only happens before the first board lands. Once
 * the board is loaded there is no race with its poll — one that started before the sweep finished was answered long
 * before this debounced patch runs, and one that starts after it reads the same new snapshot.
 */
export async function refreshCommanderBoardPullRequests(
    sessionIds: ReadonlySet<string>,
): Promise<void> {
    if (sessionIds.size === 0) return;
    const boardKey = caxriQueryKey('commander.board', undefined);
    if (!queryClient.getQueryData(boardKey)) {
        await queryClient.invalidateQueries({ queryKey: boardKey });
        return;
    }
    const snapshot = await fetchCaxriQuery('session.pullRequests', undefined, { staleTime: 0 });
    queryClient.setQueryData<CommanderBoard>(
        boardKey,
        (board) => board && patchCommanderBoardPullRequests(board, snapshot, sessionIds),
    );
}
