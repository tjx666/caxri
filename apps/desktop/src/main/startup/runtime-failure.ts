import { translateMain } from '../locale';
import type { RecoveryChoice } from './startup-failure';

/**
 * Dialog shown once Server Core has given up restarting: Relaunch Caxri, Reveal Logs in Finder, Quit.
 */
function runtimeFailureDialog() {
    return {
        type: 'error' as const,
        title: translateMain('desktop.runtimeFailed.title'),
        message: translateMain('desktop.runtimeFailed.message'),
        detail: translateMain('desktop.runtimeFailed.detail'),
        buttons: [
            translateMain('desktop.runtimeFailed.relaunch'),
            translateMain('desktop.runtimeFailed.revealLogs'),
            translateMain('desktop.runtimeFailed.quit'),
        ],
        defaultId: 0,
        cancelId: 2,
    };
}

/**
 * Maps a button index of {@link runtimeFailureDialog} to its action; here `retry` means relaunch.
 */
export function runtimeFailureChoice(response: number): RecoveryChoice {
    if (response === 0) return 'retry';
    if (response === 1) return 'reveal';
    return 'quit';
}

interface RuntimeFailurePromptOptions {
    quit(): void;
    relaunch(): void;
    revealLogs(): void;
    showDialog(options: ReturnType<typeof runtimeFailureDialog>): Promise<{ response: number }>;
}

/**
 * Opens the failure dialog once per transition into `failed`. Repeated `failed` events and a dialog that is still open
 * never stack a second one; leaving `failed` (the Server recovered) re-arms it for the next failure.
 */
export function createRuntimeFailurePrompt(options: RuntimeFailurePromptOptions) {
    let wasFailed = false;
    async function prompt(): Promise<void> {
        for (;;) {
            // eslint-disable-next-line no-await-in-loop -- the dialog re-opens after Reveal Logs until a final choice
            const { response } = await options.showDialog(runtimeFailureDialog());
            const choice = runtimeFailureChoice(response);
            if (choice === 'reveal') {
                options.revealLogs();
                continue;
            }
            if (choice === 'retry') options.relaunch();
            else options.quit();
            return;
        }
    }
    return {
        observe(status: string): void {
            const isFailed = status === 'failed';
            const isEntered = isFailed && !wasFailed;
            wasFailed = isFailed;
            if (!isEntered) return;
            // eslint-disable-next-line unicorn/prefer-await -- called from a synchronous event relay
            prompt().catch(() => {});
        },
    };
}
