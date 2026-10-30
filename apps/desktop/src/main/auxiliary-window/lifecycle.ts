import type { CaxriBotWindowController } from '../caxri-bot-window';
import type { ProcessExplorerWindowController } from '../process-explorer/window';

/**
 * Reopens Caxri Bot exactly where the app quit if it was open then, restoring its remembered bounds and resuming Caxri
 * Bot via `bot.ensure` (`CaxriBotWindowController.open`); a closed Caxri Bot stays closed. Process Explorer never
 * reopens itself; only its bounds are remembered for the next manual open. Callers run this after Server startup is up
 * and the Workbench window's Renderer has actually finished booting, not merely after `openMainWindow` returns (which
 * only creates the `BrowserWindow` and starts its navigation); otherwise a reopened Caxri Bot could appear, and
 * possibly steal focus, before the Workbench has anything to show; see `docs/caxri-bot.md`.
 */
export async function reopenAuxiliaryWindowsAtStartup(
    caxriBot: CaxriBotWindowController | undefined,
    processExplorer: ProcessExplorerWindowController | undefined,
): Promise<void> {
    const wasBotOpenAtQuit = (await caxriBot?.loadPersistedState()) ?? false;
    await processExplorer?.loadPersistedState();
    if (wasBotOpenAtQuit) caxriBot?.open();
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
        persisters.map((persist) => {
            /**
             * A persister that throws synchronously, instead of returning a rejected promise, would otherwise throw out
             * of this `.map()` call itself and abort the whole array before `Promise.allSettled` ever runs, skipping
             * every persister queued after it. Catching it here turns that throw into one more settled outcome,
             * preserving the "one failure never drops another's persist" guarantee above.
             */
            try {
                return persist() ?? Promise.resolve();
            } catch (error) {
                return Promise.reject(error instanceof Error ? error : new Error(String(error)));
            }
        }),
    );
    const failure = results.find(
        (result): result is PromiseRejectedResult => result.status === 'rejected',
    );
    if (failure) throw failure.reason as Error;
}
