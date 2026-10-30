import { execFile } from 'node:child_process';

import type { AgentSystemNotification } from './agent-notifications';

const OSASCRIPT_EXECUTABLE = '/usr/bin/osascript';
const OSASCRIPT_TIMEOUT_MS = 5_000;
const MAX_FIELD_LENGTH = 1_000;

/**
 * The whole script. It never contains notification text: title, body, and subtitle arrive as `argv` items, so quotes,
 * backslashes, and AppleScript keywords inside a Session title or an Agent reply cannot change what the script does.
 */
const NOTIFICATION_SCRIPT_LINES = [
    'on run argv',
    'display notification (item 2 of argv) with title (item 1 of argv) subtitle (item 3 of argv) sound name "default"',
    'end run',
] as const;

/**
 * Makes one notification field safe to hand to `osascript` as an argv item: control characters (newlines included)
 * become spaces, so a banner stays one tidy line and no NUL reaches the process spawn, and the length is bounded.
 */
export function sanitizeOsascriptText(text: string): string {
    // eslint-disable-next-line no-control-regex -- control characters are exactly what this removes
    return text.replaceAll(/[\u{0}-\u{1F}\u{7F}]+/gu, ' ').slice(0, MAX_FIELD_LENGTH);
}

/**
 * Structured argv for `osascript`. The `--` stops option parsing so a title that starts with `-` stays an argument.
 */
export function buildOsascriptArguments(
    notification: Pick<AgentSystemNotification, 'body' | 'subtitle' | 'title'>,
): string[] {
    return [
        ...NOTIFICATION_SCRIPT_LINES.flatMap((line) => ['-e', line]),
        '--',
        sanitizeOsascriptText(notification.title),
        sanitizeOsascriptText(notification.body),
        sanitizeOsascriptText(notification.subtitle ?? ''),
    ];
}

export interface OsascriptNotificationDriver {
    /**
     * Resolves true when `osascript` accepted the banner and false when it could not run. A banner shown this way has
     * no click target, so it cannot focus a Session.
     */
    show(notification: AgentSystemNotification): Promise<boolean>;
}

interface CreateOsascriptNotificationDriverOptions {
    run?: (executable: string, arguments_: readonly string[]) => Promise<boolean>;
}

function runOsascript(executable: string, arguments_: readonly string[]): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
        try {
            execFile(executable, [...arguments_], { timeout: OSASCRIPT_TIMEOUT_MS }, (error) =>
                resolve(error === null),
            );
        } catch {
            resolve(false);
        }
    });
}

/**
 * The last-resort banner path for an unsigned build without the notification helper: Electron's notification API needs
 * a signed app there, but `osascript` can still post a plain macOS banner.
 */
export function createOsascriptNotificationDriver(
    options: CreateOsascriptNotificationDriverOptions = {},
): OsascriptNotificationDriver {
    const run = options.run ?? runOsascript;
    return {
        show: (notification) => run(OSASCRIPT_EXECUTABLE, buildOsascriptArguments(notification)),
    };
}
