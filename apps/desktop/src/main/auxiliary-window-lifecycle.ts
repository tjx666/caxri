import type { AgentCommanderWindowController } from './agent-commander-window';
import type { ProcessExplorerWindowController } from './process-explorer-window';

/**
 * Reopens the Agent Commander exactly where the app quit if it was open then, restoring its remembered bounds and
 * resuming the Commander via `commander.ensure` (`AgentCommanderWindowController.open`); a closed Commander stays
 * closed. Process Explorer never reopens itself; only its bounds are remembered for the next manual open. Callers run
 * this after the Workbench window and Server startup are already up, so the reopened Commander never races their
 * readiness; see `docs/agent-commander.md`.
 */
export async function reopenAuxiliaryWindowsAtStartup(
    agentCommander: AgentCommanderWindowController | undefined,
    processExplorer: ProcessExplorerWindowController | undefined,
): Promise<void> {
    const wasCommanderOpenAtQuit = (await agentCommander?.loadPersistedState()) ?? false;
    await processExplorer?.loadPersistedState();
    if (wasCommanderOpenAtQuit) agentCommander?.open();
}

/**
 * Runs every window-state persister independently, so one window's failure never drops another's; the first rejection
 * (if any) still surfaces to the caller once every persister has settled. Used at quit to flush the main window's
 * realtime-persisted bounds alongside the two optional windows' bounds/open state, which are otherwise only ever
 * written here.
 */
export async function persistAllWindowState(
    persisters: ReadonlyArray<() => Promise<unknown> | undefined>,
): Promise<void> {
    const results = await Promise.allSettled(
        persisters.map((persist) => persist() ?? Promise.resolve()),
    );
    const failure = results.find(
        (result): result is PromiseRejectedResult => result.status === 'rejected',
    );
    if (failure) throw failure.reason as Error;
}
