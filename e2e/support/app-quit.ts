import type { MessageBoxOptions } from 'electron';

import { desktop as enDesktop } from '../../apps/desktop/src/shared/i18n/en/desktop.ts';
import { desktop as zhDesktop } from '../../apps/desktop/src/shared/i18n/zh-cn/desktop.ts';
import type { E2EApp } from './electron-app.ts';

/**
 * Stubs only the native decisions used by graceful application quit. Teardown defaults to stopping test tasks so a new
 * quit prompt cannot stall Playwright; restart scenarios explicitly preserve the Host instead. Use shipped translations
 * because locale-changing scenarios can reach teardown in either language.
 */
export async function stubAppQuitDecision(
    app: E2EApp,
    decision: 'keep-running' | 'stop',
): Promise<void> {
    await app.evaluate(
        ({ dialog }, { response, titles }) => {
            dialog.showMessageBox = (
                windowOrOptions: unknown,
                maybeOptions?: MessageBoxOptions,
            ) => {
                const options = maybeOptions ?? (windowOrOptions as MessageBoxOptions);
                // Teardown discards drafts a review-comment test left behind (issue caxri#1294); the reminder's
                // wording, Cancel default, and quit gating are covered by `apps/desktop/src/main/__tests__/app-quit.test.ts`.
                if (titles.review.includes(options.title ?? ''))
                    return Promise.resolve({ response: 0, checkboxChecked: false });
                // Teardown discards Editor buffers a test left unsaved (issue caxri#1631): response 1 is "Don't Save".
                // `e2e/editor-quit-unsaved.e2e.ts` covers the prompt itself.
                if (titles.unsaved.includes(options.title ?? ''))
                    return Promise.resolve({ response: 1, checkboxChecked: false });
                if (!titles.quit.includes(options.title ?? ''))
                    throw new Error(
                        `Unexpected dialog during E2E quit: ${options.title ?? 'untitled'}`,
                    );
                return Promise.resolve({ response, checkboxChecked: false });
            };
        },
        {
            response: decision === 'stop' ? 0 : 1,
            titles: {
                review: [
                    enDesktop['desktop.quit.reviewTitle'],
                    zhDesktop['desktop.quit.reviewTitle'],
                ],
                unsaved: [enDesktop['desktop.unsaved.title'], zhDesktop['desktop.unsaved.title']],
                quit: [enDesktop['desktop.quit.title'], zhDesktop['desktop.quit.title']],
            },
        },
    );
}
