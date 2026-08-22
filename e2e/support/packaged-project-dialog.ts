import type { RunningCaxri } from './helpers.ts';

/**
 * Routes the packaged app's native folder picker to an isolated E2E Project root.
 */
export async function stubPackagedProjectDialog(
    running: RunningCaxri,
    projectRoot: string,
    executablePath: string | undefined,
): Promise<void> {
    if (!executablePath) return;
    await running.app.evaluate(({ dialog }, selectedRoot) => {
        dialog.showOpenDialog = () =>
            Promise.resolve({
                canceled: false,
                filePaths: [selectedRoot],
            });
    }, projectRoot);
}
