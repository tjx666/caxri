export type E2EWindowMode = 'hidden' | 'visible';

/**
 * Production windows always remain visible. Only an E2E launch may suppress native presentation, and focused tests
 * default to that hidden path unless their fixture opts into desktop behavior.
 */
export function resolveE2EWindowMode(environment: {
    CAXRI_E2E?: string;
    CAXRI_E2E_WINDOW_MODE?: string;
}): E2EWindowMode {
    if (environment.CAXRI_E2E !== '1') return 'visible';
    return environment.CAXRI_E2E_WINDOW_MODE === 'visible' ? 'visible' : 'hidden';
}

/**
 * The `BrowserWindow` surface `bringWindowForward` drives, kept structural so the branch stays unit-testable.
 */
export interface ForwardableWindow {
    isMinimized(): boolean;
    restore(): void;
    show(): void;
    focus(): void;
    webContents: { focus(): void };
}

/**
 * Brings a window to the front for a user hand-off (Agent Commander, notifications, second instance, menu). A hidden
 * E2E launch only focuses the window's web contents: `show()`, `app.focus({ steal: true })`, and macOS
 * `BrowserWindow.focus()` (which orders the window front) would surface it and take OS focus from the developer's
 * foreground app and from sibling parallel E2E workers. Production and visible E2E launches keep the full behavior.
 */
export function bringWindowForward(options: {
    app: { focus(options: { steal: boolean }): void };
    window: ForwardableWindow;
    windowMode: E2EWindowMode;
}): void {
    const { app, window, windowMode } = options;
    if (windowMode === 'hidden') {
        window.webContents.focus();
        return;
    }
    if (window.isMinimized()) window.restore();
    window.show();
    app.focus({ steal: true });
    window.focus();
}
