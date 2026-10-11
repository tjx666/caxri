import type { MessageBoxOptions } from 'electron';

import type { E2EApp } from './electron-app.ts';

/**
 * Stubs only the native decisions used by graceful application quit. Teardown defaults to stopping test tasks so a new
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
                // Teardown discards drafts a review-comment test left behind (issue caxri#1294); the reminder's
                // wording, Cancel default, and quit gating are covered by `apps/desktop/src/main/__tests__/app-quit.test.ts`.
                if (options.title === 'Quit with pending review comments?')
                    return Promise.resolve({ response: 0, checkboxChecked: false });
                // Teardown discards Editor buffers a test left unsaved (issue caxri#1631): response 1 is "Don't Save".
                // `e2e/editor-quit-unsaved.e2e.ts` covers the prompt itself.
                if (options.title === 'Unsaved Changes')
                    return Promise.resolve({ response: 1, checkboxChecked: false });
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
