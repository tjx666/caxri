import type { MessageBoxOptions } from 'electron';

import type { E2EApp } from './electron-app.ts';

/**
 * Stubs only the native decision used by graceful application quit. Teardown defaults to stopping test tasks so a new
 * quit prompt cannot stall Playwright; restart scenarios explicitly preserve the Host instead.
 */
export async function stubAppQuitDecision(
    app: E2EApp,
    decision: 'keep-running' | 'stop',
): Promise<void> {
    await app.evaluate(
        ({ dialog }, response) => {
            dialog.showMessageBox = (
                windowOrOptions: unknown,
                maybeOptions?: MessageBoxOptions,
            ) => {
                const options = maybeOptions ?? (windowOrOptions as MessageBoxOptions);
                if (options.title !== 'Quit Caxri?')
                    throw new Error(
                        `Unexpected dialog during E2E quit: ${options.title ?? 'untitled'}`,
                    );
                return Promise.resolve({ response, checkboxChecked: false });
            };
        },
        decision === 'stop' ? 0 : 1,
    );
}
