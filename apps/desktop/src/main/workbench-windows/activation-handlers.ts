import type { App } from 'electron';

/**
 * Re-opens the primary window when the app is activated and re-validates Workbench Roots whenever a window gains focus.
 * Both listeners are synchronous, so a failed validation pass surfaces on the next one instead of throwing.
 */
export function installActivationHandlers(options: {
    app: Pick<App, 'on'>;
    openMainWindow: () => void;
    validateWorkbenchRoots: () => Promise<unknown>;
}): void {
    const validate = (): void => {
        // eslint-disable-next-line unicorn/prefer-await -- synchronous listener, see above
        options.validateWorkbenchRoots().catch(() => {});
    };
    options.app.on('activate', () => {
        options.openMainWindow();
        validate();
    });
    options.app.on('browser-window-focus', validate);
}
