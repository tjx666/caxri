/**
 * Pure field construction for mirrored Renderer `console-message` errors. Kept free of Electron imports so the
 * truncation contract is unit testable and the wiring in `index.ts` / `process-explorer-window.ts` stays a thin caller.
 * The structured logger already redacts secret-shaped text and home-directory paths from string fields, so the message
 * can be logged verbatim here.
 */

/**
 * Component stacks from React error boundaries can run to tens of kilobytes; cap the mirrored message so a single
 * console error cannot burn through the 5 MB log rotation budget.
 */
const MAX_MESSAGE_LENGTH = 4000;

export interface ConsoleErrorDetails {
    message: string;
    sourceId?: string;
    lineNumber?: number;
}

export function consoleErrorLogFields(
    details: ConsoleErrorDetails,
): Record<string, string | number> {
    const isTruncated = details.message.length > MAX_MESSAGE_LENGTH;
    return {
        code: 'CONSOLE_ERROR',
        message: isTruncated
            ? `${details.message.slice(0, MAX_MESSAGE_LENGTH)}… [truncated]`
            : details.message,
        source: `${details.sourceId ?? '<unknown>'}:${details.lineNumber ?? 0}`,
    };
}
