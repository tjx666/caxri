const BENIGN_RENDERER_ERROR_MESSAGES = new Set([
    'ResizeObserver loop completed with undelivered notifications.',
    'ResizeObserver loop limit exceeded',
]);

/**
 * Chromium reports deferred ResizeObserver delivery through both `window.error` and `console-message` even though it
 * resumes delivery on the next frame. Treat only the browser's fixed messages as non-faults so real callback failures,
 * unknown variants, and application exceptions remain visible to diagnostics and the E2E error gate.
 */
export function isBenignRendererErrorMessage(message: unknown): boolean {
    return typeof message === 'string' && BENIGN_RENDERER_ERROR_MESSAGES.has(message);
}
