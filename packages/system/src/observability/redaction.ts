import { homedir, userInfo } from 'node:os';

import { isSecretKey, redactSecretText } from '@caxri/utils';

/**
 * Node-only because it depends on `homedir()`; never import from apps/desktop/src/renderer. Shared by the structured
 * logger and diagnostics export so credential-shaped text is redacted identically wherever it is written to disk.
 */
export { isSecretKey } from '@caxri/utils';

/**
 * The OS account's home from the password database. It differs from `homedir()` when a launcher overrides `HOME`: E2E
 * and Acceptance run Caxri with an isolated fixture HOME while a CI runner's workspace and job temp root can still sit
 * under the runner account's real home, so redacting only `homedir()` leaves the account name in every fixture path
 * (issue #1461).
 */
function readAccountHome(): string | undefined {
    try {
        return userInfo().homedir || undefined;
    } catch {
        // `userInfo()` throws when the uid has no password-database entry; `homedir()` still covers HOME.
        return undefined;
    }
}

const accountHome = readAccountHome();

/**
 * Replaces both the process HOME and the OS account home with `$HOME`, longest first so a HOME nested under the account
 * home keeps its own token. A root-level or empty home would erase every absolute path, so it is skipped.
 */
function redactHomePaths(value: string): string {
    const homes = [...new Set([homedir(), accountHome])]
        .filter((home): home is string => Boolean(home) && home !== '/')
        .toSorted((left, right) => right.length - left.length);
    return homes.reduce((redacted, home) => redacted.replaceAll(home, '$HOME'), value);
}

/**
 * Redacts home paths, secret-shaped tokens, and `key=value` assignments from free-form log text.
 */
export function redactLogValue(value: string): string {
    return redactSecretText(redactHomePaths(value));
}

/**
 * Recursively redacts secret-shaped keys and values from structured diagnostics data.
 */
export function redactSecrets(value: unknown, key = ''): unknown {
    if (isSecretKey(key)) return '[REDACTED]';
    if (Array.isArray(value)) return value.map((item) => redactSecrets(item));
    if (value && typeof value === 'object') {
        return Object.fromEntries(
            Object.entries(value).map(([childKey, child]) => [
                childKey,
                redactSecrets(child, childKey),
            ]),
        );
    }
    if (typeof value === 'string') {
        return redactLogValue(value);
    }
    return value;
}
